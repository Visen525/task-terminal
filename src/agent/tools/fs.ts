/**
 * 子智能体 · 文件工具（SPEC §4.6 / §7 M3-02）
 *
 * 所有副作用仍然经过 `executeTool` 单一出口：本模块只提供 handler 并向
 * 注册表登记，路径一律先走 `resolveWorkspacePath`，不自行拼接后直接读盘。
 *
 * read_file 的实现保留在 executeTool.ts（M3-01 已验证的代码不搬动），
 * 由本模块 re-export；本模块负责其余四个文件工具。runner 侧统一从
 * executeTool 的 TOOL_SPECS 读取六件套声明。
 */
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  type Dirent,
  type Stats,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import { ContractError, ERROR_CODES } from "../../core/errors.ts";
import {
  GLOB_SPEC,
  GREP_SPEC,
  LIST_DIR_SPEC,
  READ_FILE_SPEC,
  WRITE_FILE_SPEC,
  readFileTool,
  registerTool,
  resolveWorkspacePath,
  type ToolContext,
  type ToolExecution,
} from "../executeTool.ts";

// 实现保留在 executeTool；按 M3-02 约定由本模块 re-export。
export { READ_FILE_SPEC, readFileTool };

export const DEFAULT_LIST_DIR_LIMIT = 500;
export const DEFAULT_GLOB_LIMIT = 200;
export const DEFAULT_GREP_LIMIT = 200;
export const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024;

const isWindows = process.platform === "win32";

// ── 通用小工具 ───────────────────────────────────────────────────

function asRecord(args: unknown): Record<string, unknown> | null {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return null;
  return args as Record<string, unknown>;
}

function invalid(message: string): ToolExecution {
  return { ok: false, code: ERROR_CODES.E_INVALID_ARGUMENT, output: message, preview: message };
}

function internalError(message: string): ToolExecution {
  return { ok: false, code: ERROR_CODES.E_INTERNAL, output: message, preview: message };
}

function isEscapeError(error: unknown): boolean {
  return error instanceof ContractError && error.code === ERROR_CODES.E_WORKSPACE_ESCAPE;
}

function workspaceRoot(ctx: ToolContext): string {
  return resolveWorkspacePath(ctx, ".", "read");
}

function toPosix(input: string): string {
  return input.split(sep).join("/");
}

function relativePosix(root: string, full: string): string {
  const rel = relative(root, full);
  return rel.length === 0 ? "." : toPosix(rel);
}

function byName(a: { name: string }, b: { name: string }): number {
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
}

function byPath(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

// ── list_dir ─────────────────────────────────────────────────────

interface DirEntryInfo {
  name: string;
  isDirectory: boolean;
  size: number;
}

function listDirTool(ctx: ToolContext, args: unknown): ToolExecution {
  const record = asRecord(args);
  if (record === null) return invalid("list_dir expects an object argument");

  const rawPath = record.path;
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    return invalid("list_dir requires a non-empty path");
  }

  const root = workspaceRoot(ctx);
  const dir = resolveWorkspacePath(ctx, rawPath, "read");

  try {
    if (!statSync(dir).isDirectory()) return invalid("path is not a directory");
  } catch (error) {
    if (errnoCode(error) === "ENOENT" || errnoCode(error) === "ENOTDIR") {
      return {
        ok: false,
        code: ERROR_CODES.E_NOT_FOUND,
        output: "directory not found",
        preview: "directory not found",
      };
    }
    return internalError("directory could not be read");
  }

  let dirents: Dirent[];
  try {
    dirents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return internalError("directory could not be read");
  }

  const entries: DirEntryInfo[] = [];
  for (const dirent of dirents) {
    // 不跟随符号链接：既避免循环，也避免把工作区外目标带进结果。
    if (dirent.isSymbolicLink()) continue;
    const full = join(dir, dirent.name);
    const rel = relativePosix(root, full);

    let resolved: string;
    try {
      resolved = resolveWorkspacePath(ctx, rel, "read");
    } catch (error) {
      if (isEscapeError(error)) continue;
      throw error;
    }

    let size: number;
    try {
      size = lstatSync(resolved).size;
    } catch (error) {
      if (errnoCode(error) === "ENOENT") continue;
      return internalError("directory entry could not be read");
    }

    entries.push({ name: dirent.name, isDirectory: dirent.isDirectory(), size });
  }

  entries.sort(byName);
  const total = entries.length;
  const limited = entries.slice(0, DEFAULT_LIST_DIR_LIMIT);
  const truncated = total > limited.length;
  const output = JSON.stringify({
    path: relativePosix(root, dir),
    entries: limited,
    total,
    returned: limited.length,
    truncated,
  });

  return {
    ok: true,
    output,
    preview: `listed ${limited.length} entries`,
    truncated,
  };
}

// ── glob ─────────────────────────────────────────────────────────

function normalizeGlobPattern(raw: string): string | null {
  let pattern = raw.replace(/\\/g, "/");
  while (pattern.startsWith("./")) pattern = pattern.slice(2);
  if (pattern.trim().length === 0 || pattern.includes("\0")) return null;
  // 模式始终相对工作区根；绝对/盘符模式直接报参数错误，不做“猜测性”改写。
  if (pattern.startsWith("/") || /^[A-Za-z]:/.test(pattern)) return null;
  if (pattern.split("/").some((segment) => segment === "..")) return null;
  return pattern;
}

function escapeRegExpChar(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

/**
 * 把 glob 模式翻译成正则：
 *   *  → 段内任意字符（不跨 /）
 *   ?  → 段内单个字符（不跨 /）
 *   ** → 跨目录任意字符；`**​/` 可匹配零层目录
 */
function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern.charAt(i);
    if (char === "*") {
      let stars = 1;
      while (pattern.charAt(i + stars) === "*") stars += 1;
      if (stars >= 2) {
        if (pattern.charAt(i + stars) === "/") {
          source += "(?:[^/]+/)*";
          i += stars; // 连同后面的 / 一起消费
        } else {
          source += ".*";
          i += stars - 1;
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += escapeRegExpChar(char);
  }
  source += "$";
  return new RegExp(source, isWindows ? "i" : "");
}

interface WalkEntry {
  rel: string;
  full: string;
  isFile: boolean;
  isDirectory: boolean;
}

/**
 * 从 startDir 开始递归遍历；跳过符号链接，所有条目都先经
 * resolveWorkspacePath 校验。回调返回 false 时提前结束。
 */
function walkWorkspace(
  ctx: ToolContext,
  startDir: string,
  onEntry: (entry: WalkEntry) => boolean,
): void {
  const root = workspaceRoot(ctx);

  const visit = (dir: string): boolean => {
    let dirents: Dirent[];
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      const code = errnoCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") return true;
      throw new ContractError(ERROR_CODES.E_INTERNAL, "directory could not be read");
    }
    dirents.sort(byName);

    for (const dirent of dirents) {
      // 跳过符号链接，防止目录环和越界目标。
      if (dirent.isSymbolicLink()) continue;
      const full = join(dir, dirent.name);
      const rel = relativePosix(root, full);

      let resolved: string;
      try {
        resolved = resolveWorkspacePath(ctx, rel, "read");
      } catch (error) {
        if (isEscapeError(error)) continue;
        throw error;
      }

      const isDirectory = dirent.isDirectory();
      const isFile = dirent.isFile();
      if (!onEntry({ rel, full: resolved, isFile, isDirectory })) return false;

      if (isDirectory) {
        if (!visit(resolved)) return false;
      }
    }
    return true;
  };

  visit(startDir);
}

function globTool(ctx: ToolContext, args: unknown): ToolExecution {
  const record = asRecord(args);
  if (record === null) return invalid("glob expects an object argument");

  const rawPattern = record.pattern;
  if (typeof rawPattern !== "string" || rawPattern.length === 0) {
    return invalid("glob requires a non-empty pattern");
  }
  const pattern = normalizeGlobPattern(rawPattern);
  if (pattern === null) {
    return invalid("glob pattern must be a relative pattern without '..'");
  }

  let matcher: RegExp;
  try {
    matcher = globToRegExp(pattern);
  } catch {
    return invalid("glob pattern is invalid");
  }

  const root = workspaceRoot(ctx);
  const matches: string[] = [];
  walkWorkspace(ctx, root, (entry) => {
    // glob 面向可读取的文件；目录只参与递归，不进入结果。
    if (entry.isFile && matcher.test(entry.rel)) matches.push(entry.rel);
    return true;
  });

  matches.sort(byPath);
  const total = matches.length;
  const returned = matches.slice(0, DEFAULT_GLOB_LIMIT);
  const truncated = total > returned.length;

  let output = returned.join("\n");
  if (truncated) {
    output += `${output.length > 0 ? "\n" : ""}…[truncated: showing ${returned.length} of ${total} matches]…`;
  }

  return {
    ok: true,
    output,
    preview: `glob matched ${total} file(s)`,
    truncated,
  };
}

// ── grep ─────────────────────────────────────────────────────────

interface GrepState {
  hits: string[];
  skippedLarge: number;
  truncated: boolean;
}

function grepOneFile(rel: string, full: string, matcher: RegExp, state: GrepState): void {
  let size: number;
  try {
    size = statSync(full).size;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return;
    throw new ContractError(ERROR_CODES.E_INTERNAL, "file could not be read");
  }
  if (size > MAX_GREP_FILE_BYTES) {
    state.skippedLarge += 1;
    return;
  }

  let text: string;
  try {
    text = readFileSync(full, "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return;
    throw new ContractError(ERROR_CODES.E_INTERNAL, "file could not be read");
  }
  if (text.length === 0) return;

  const lines = text.split(/\r?\n/);
  // 文件以换行结尾时 split 会多出一个空串；它不是真实的一行。
  if (lines.length > 0 && lines[lines.length - 1] === "" && text.endsWith("\n")) lines.pop();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!matcher.test(line)) continue;
    if (state.hits.length >= DEFAULT_GREP_LIMIT) {
      state.truncated = true;
      return;
    }
    state.hits.push(`${rel}:${i + 1}: ${line}`);
  }
}

function grepTool(ctx: ToolContext, args: unknown): ToolExecution {
  const record = asRecord(args);
  if (record === null) return invalid("grep expects an object argument");

  const rawPattern = record.pattern;
  if (typeof rawPattern !== "string" || rawPattern.length === 0) {
    return invalid("grep requires a non-empty pattern");
  }

  let matcher: RegExp;
  try {
    matcher = new RegExp(rawPattern);
  } catch {
    // 不回显原始正则/路径，避免把调用方输入带进事件或上层错误。
    return invalid("invalid regular expression");
  }

  const rawPath = record.path;
  if (rawPath !== undefined && (typeof rawPath !== "string" || rawPath.trim().length === 0)) {
    return invalid("path must be a non-empty string");
  }

  const root = workspaceRoot(ctx);
  const target = resolveWorkspacePath(ctx, typeof rawPath === "string" ? rawPath : ".", "read");

  let targetStat: Stats;
  try {
    targetStat = statSync(target);
  } catch (error) {
    if (errnoCode(error) === "ENOENT" || errnoCode(error) === "ENOTDIR") {
      return {
        ok: false,
        code: ERROR_CODES.E_NOT_FOUND,
        output: "path not found",
        preview: "path not found",
      };
    }
    return internalError("path could not be read");
  }

  const state: GrepState = { hits: [], skippedLarge: 0, truncated: false };

  if (targetStat.isFile()) {
    grepOneFile(relativePosix(root, target), target, matcher, state);
  } else if (targetStat.isDirectory()) {
    walkWorkspace(ctx, target, (entry) => {
      if (entry.isFile) grepOneFile(entry.rel, entry.full, matcher, state);
      return !state.truncated;
    });
  } else {
    return invalid("path is neither a file nor a directory");
  }

  let output = state.hits.join("\n");
  if (state.truncated) {
    output += `${output.length > 0 ? "\n" : ""}…[truncated: showing first ${DEFAULT_GREP_LIMIT} matches]…`;
  }
  if (state.skippedLarge > 0) {
    output += `${output.length > 0 ? "\n" : ""}…[skipped ${state.skippedLarge} file(s) larger than 2MB]…`;
  }

  return {
    ok: true,
    output,
    preview: `grep matched ${state.hits.length} line(s)`,
    truncated: state.truncated,
  };
}

// ── write_file ───────────────────────────────────────────────────

function writeFileTool(ctx: ToolContext, args: unknown): ToolExecution {
  const record = asRecord(args);
  if (record === null) return invalid("write_file expects an object argument");

  const rawPath = record.path;
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    return invalid("write_file requires a non-empty path");
  }
  const content = record.content;
  if (typeof content !== "string") {
    return invalid("write_file requires string content");
  }

  // write 权限与路径逃逸校验都在这里完成（不另写一套路径逻辑）。
  const target = resolveWorkspacePath(ctx, rawPath, "write");

  // 写前算 sha256；结果对象与 agent.tool_result 事件 payload 都记录它。
  const bytes = Buffer.byteLength(content, "utf8");
  const sha256 = createHash("sha256").update(content, "utf8").digest("hex");

  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  } catch {
    return internalError("file could not be written");
  }

  const root = workspaceRoot(ctx);
  const rel = relativePosix(root, target);
  return {
    ok: true,
    output: JSON.stringify({ path: rel, bytes, sha256 }),
    preview: `wrote ${bytes} bytes to ${rel}`,
    sha256,
    bytes,
  };
}

// ── 注册 ─────────────────────────────────────────────────────────

/** 由 executeTool 在首次调用时执行，确保模块常量已全部初始化。 */
export function registerFsTools(): void {
  registerTool({ spec: READ_FILE_SPEC, handler: readFileTool });
  registerTool({ spec: LIST_DIR_SPEC, handler: listDirTool });
  registerTool({ spec: GLOB_SPEC, handler: globTool });
  registerTool({ spec: GREP_SPEC, handler: grepTool });
  registerTool({ spec: WRITE_FILE_SPEC, handler: writeFileTool });
}
