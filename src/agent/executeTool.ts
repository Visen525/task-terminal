/**
 * 执行内核 · 工具单一出口（SPEC §4.5 / §4.6 / §7 M3-01）
 *
 * 所有副作用都必须经过 `executeTool`：
 *   - 路径校验：resolve → 最深存在祖先 realpath → 大小写归一化前缀比较
 *   - 命令硬拒绝：argv 级检查，拒绝逻辑先于任何 spawn
 *   - 超时：到点杀进程树，抛 E_TOOL_TIMEOUT
 *   - 输出截断：返回头尾，全量原文落盘
 *   - 事件：执行前后各一条，成功失败都成对
 *
 * 本卡只内建 read_file / run_command 两个示范工具；M3-02 的其余工具
 * 必须继续复用本文件的路径校验与执行原语。
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { ContractError, ERROR_CODES, type ErrorCode } from "../core/errors.ts";
import type { PermissionMode, ToolSpec } from "../core/types.ts";
import { appendEvent } from "../store/events.ts";
import { registerFsTools } from "./tools/fs.ts";
import { DEFAULT_ALLOWED_COMMANDS, registerShellTools } from "./tools/shell.ts";

// shell.ts 是白名单常量的归属地；这里一并导出，调用方不必跨模块猜测。
export { DEFAULT_ALLOWED_COMMANDS };

// ── 常量 ─────────────────────────────────────────────────────────

/** 工具默认超时：SPEC 没有单列工具超时，取与 provider 读取超时一致的 120s。 */
export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
/** 返回给调用方的输出上限（200KB），超出保留头尾。 */
export const DEFAULT_MAX_OUTPUT_BYTES = 200 * 1024;
/** agent.tool_call.args_preview 的最大字符数。 */
export const MAX_ARGS_PREVIEW_CHARS = 500;
/** 事件 preview 的最大字符数。 */
const MAX_EVENT_PREVIEW_CHARS = 500;
/** 杀树后等待 close 的兜底时间。 */
const KILL_GRACE_MS = 2_000;

/** 不属于 core 错误码的“命令执行失败”结果码。 */
export const TOOL_ERROR_CODES = {
  E_TOOL_EXIT: "E_TOOL_EXIT",
} as const;
export type ToolErrorCode = ErrorCode | (typeof TOOL_ERROR_CODES)[keyof typeof TOOL_ERROR_CODES];

const DENIED_COMMAND_STEMS = new Set([
  "format",
  "diskpart",
  "bcdedit",
  "shutdown",
  "takeown",
  "icacls",
]);
const DELETE_COMMAND_STEMS = new Set(["del", "erase", "rd", "rmdir", "rm"]);
// shell 内层额外识别 PowerShell 的完整 cmdlet 名与常用别名。
const SHELL_DELETE_COMMAND_STEMS = new Set([...DELETE_COMMAND_STEMS, "remove-item", "ri"]);
const SHELL_COMMAND_STEMS = new Set(["cmd", "sh", "bash", "dash", "zsh", "ksh"]);
const POWERSHELL_STEMS = new Set(["powershell", "pwsh"]);

const SECRET_KEY_RE = /api[-_]?key|token|secret|password|authorization/i;

// ── 公共类型 ─────────────────────────────────────────────────────

export type PathAccess = "read" | "write";

export interface ToolContext {
  /** 工作区根；由 createToolContext 在启动时 realpath 一次。 */
  workspace: string;
  db: DatabaseSync;
  taskId: string | null;
  runId: string | null;
  /** 缺省/非法值一律按 read-only 处理（安全默认）。 */
  permission: PermissionMode;
  signal?: AbortSignal;
  /** 命令超时，默认 DEFAULT_TOOL_TIMEOUT_MS。 */
  timeoutMs?: number;
  /** 全量输出目录，默认 <cwd>/data/tool-outputs。 */
  outputDir?: string;
  /** 返回输出上限，默认 DEFAULT_MAX_OUTPUT_BYTES。 */
  maxOutputBytes?: number;
  /** 子进程环境变量，默认 process.env（测试可注入）。 */
  env?: NodeJS.ProcessEnv;
  /**
   * 命令白名单（argv[0] 的 commandStem 形式）；缺省用 DEFAULT_ALLOWED_COMMANDS。
   * 注入空数组 = 拒绝所有命令。
   */
  allowedCommands?: readonly string[];
}

export interface CreateToolContextOptions {
  workspace: string;
  db: DatabaseSync;
  taskId?: string | null;
  runId?: string | null;
  permission?: PermissionMode;
  signal?: AbortSignal;
  timeoutMs?: number;
  outputDir?: string;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
  allowedCommands?: readonly string[];
}

export interface ToolResult {
  ok: boolean;
  tool: string;
  /** 返回给模型的输出（>200KB 时保留头尾并带截断标记）。 */
  output: string;
  /** 写事件的短预览。 */
  preview: string;
  /** 本次调用耗时（含事件写入）。 */
  ms: number;
  /** ms 的别名，方便调用方按“耗时”命名读取。 */
  durationMs: number;
  code?: ToolErrorCode;
  error?: { code: ToolErrorCode; message: string };
  exitCode?: number | null;
  truncated: boolean;
  fullOutputPath?: string;
  fullOutputBytes?: number;
  /** write_file 写入内容的 sha256（写前计算；事件 payload 同步记录）。 */
  sha256?: string;
  /** write_file 写入内容的 UTF-8 字节数。 */
  bytes?: number;
}

// ── 工具声明（SPEC §4.6；六件套完整 JSON Schema，M3-03 直接喂给 provider）──

export const READ_FILE_SPEC: ToolSpec = {
  name: "read_file",
  description: "读取工作区内文件的文本内容，可按字符分页。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "工作区内的相对或绝对路径" },
      offset: { type: "integer", minimum: 0, description: "起始字符偏移（从 0 开始）" },
      limit: { type: "integer", minimum: 0, description: "最多返回的字符数" },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

export const LIST_DIR_SPEC: ToolSpec = {
  name: "list_dir",
  description: "列出工作区内目录的直接子项（名称、是否目录、字节大小），最多 500 条。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "工作区内要列出的目录路径" },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

export const GLOB_SPEC: ToolSpec = {
  name: "glob",
  description:
    "从工作区根递归匹配文件路径；支持 *（段内任意字符）、?（段内单个字符）、**（跨目录）。结果按相对路径排序，最多 200 条。",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "相对工作区根的 glob 模式，例如 **/*.ts 或 src/*",
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
};

export const GREP_SPEC: ToolSpec = {
  name: "grep",
  description:
    "按行正则搜索工作区内的文件，返回 文件:行号: 行内容；默认递归工作区根，最多 200 条命中，跳过大于 2MB 的文件。",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "JavaScript 正则表达式（不携带 flags）" },
      path: {
        type: "string",
        description: "工作区内的文件或目录路径；省略时递归工作区根",
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
};

export const WRITE_FILE_SPEC: ToolSpec = {
  name: "write_file",
  description:
    "写入工作区内文件（创建父目录，可覆盖）；写前计算 content 的 sha256，返回字节数与 sha256。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "工作区内的目标文件路径" },
      content: { type: "string", description: "要写入的完整 UTF-8 文本" },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
};

export const RUN_COMMAND_SPEC: ToolSpec = {
  name: "run_command",
  description: "以 argv 数组执行工作区内命令；绝不经过 shell。argv[0] 必须在命令白名单内。",
  parameters: {
    type: "object",
    properties: {
      argv: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        description: '命令与参数数组，例如 ["node","-e","console.log(1)"]',
      },
      cwd: { type: "string", description: "工作区内的工作目录" },
    },
    required: ["argv"],
    additionalProperties: false,
  },
};

/** 子智能体六件套工具声明（read_file / list_dir / glob / grep / write_file / run_command）。 */
export const TOOL_SPECS: ToolSpec[] = [
  READ_FILE_SPEC,
  LIST_DIR_SPEC,
  GLOB_SPEC,
  GREP_SPEC,
  WRITE_FILE_SPEC,
  RUN_COMMAND_SPEC,
];

// ── 上下文与工作区根 ─────────────────────────────────────────────

interface RootInfo {
  path: string;
  key: string;
}

/** 每个 ctx 只 realpath 一次工作区根。 */
const rootCache = new WeakMap<ToolContext, RootInfo>();

const isWindows = process.platform === "win32";
const SEP_KEY = isWindows ? "\\" : "/";

function normalizeKey(input: string): string {
  let out = isWindows ? input.replace(/\//g, "\\").toLowerCase() : input;
  while (out.length > 1 && (out.endsWith("/") || out.endsWith("\\"))) {
    out = out.slice(0, -1);
  }
  return out;
}

function canonicalizeWorkspace(workspace: string): RootInfo {
  if (typeof workspace !== "string" || workspace.trim().length === 0 || workspace.includes("\0")) {
    throw new ContractError(ERROR_CODES.E_INVALID_ARGUMENT, "workspace is required");
  }
  const absolute = resolve(workspace);
  let real: string;
  try {
    real = realpathSync.native(absolute);
  } catch {
    throw new ContractError(ERROR_CODES.E_INVALID_ARGUMENT, "workspace does not exist");
  }
  let directory = false;
  try {
    directory = statSync(real).isDirectory();
  } catch {
    throw new ContractError(ERROR_CODES.E_INVALID_ARGUMENT, "workspace cannot be accessed");
  }
  if (!directory) {
    throw new ContractError(ERROR_CODES.E_INVALID_ARGUMENT, "workspace is not a directory");
  }
  return { path: real, key: normalizeKey(real) };
}

/** 白名单条目归一化：允许注入 "node.exe" 或 "C:\...\node.exe" 这类写法。 */
function normalizeAllowedCommands(input: readonly string[] | undefined): readonly string[] {
  const source = input ?? DEFAULT_ALLOWED_COMMANDS;
  const normalized = new Set<string>();
  for (const item of source) {
    if (typeof item !== "string") continue;
    const stem = commandStem(item);
    if (stem.length > 0) normalized.add(stem);
  }
  return [...normalized];
}

/** 创建工具上下文：工作区根在这里 realpath 一次。 */
export function createToolContext(options: CreateToolContextOptions): ToolContext {
  const root = canonicalizeWorkspace(options.workspace);
  const ctx: ToolContext = {
    workspace: root.path,
    db: options.db,
    taskId: options.taskId ?? null,
    runId: options.runId ?? null,
    permission: options.permission ?? "read-only",
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    outputDir: options.outputDir,
    maxOutputBytes: options.maxOutputBytes,
    env: options.env,
    allowedCommands: normalizeAllowedCommands(options.allowedCommands),
  };
  rootCache.set(ctx, root);
  return ctx;
}

function getRoot(ctx: ToolContext): RootInfo {
  const cached = rootCache.get(ctx);
  if (cached) return cached;
  const root = canonicalizeWorkspace(ctx.workspace);
  rootCache.set(ctx, root);
  return root;
}

function isInside(rootKey: string, candidateKey: string): boolean {
  if (candidateKey === rootKey) return true;
  const prefix = rootKey.endsWith(SEP_KEY) ? rootKey : rootKey + SEP_KEY;
  return candidateKey.startsWith(prefix);
}

function escapeError(): ContractError {
  return new ContractError(ERROR_CODES.E_WORKSPACE_ESCAPE, "path resolves outside workspace");
}

// ── 路径校验 ─────────────────────────────────────────────────────

function assertNotUncLike(raw: string): void {
  const path = raw.replace(/\//g, "\\");
  // \\?\UNC\server\share 是 UNC 的扩展写法。
  if (/^\\\\\?\\UNC\\/i.test(path)) throw escapeError();
  // \\.\ 设备路径。
  if (/^\\\\\.\\/.test(path)) throw escapeError();
  // 普通 UNC：\\server\share；\\?\C:\ 是扩展长度路径，交给 realpath。
  if (/^\\\\[^\\?]/.test(path)) throw escapeError();
}

/** 多层 percent 解码；返回与原文不同的每一层。 */
function decodeLayers(raw: string): string[] {
  const layers: string[] = [];
  let current = raw;
  for (let i = 0; i < 3; i += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      break;
    }
    if (decoded === current) break;
    layers.push(decoded);
    current = decoded;
  }
  return layers;
}

/**
 * 找到最深存在祖先做 realpath，再拼回不存在的尾段。
 * 这样 write_file 的新文件、以及 symlink 指向的目录都能被正确解析。
 */
function canonicalizeExistingAncestor(target: string): string {
  let probe = target;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(probe);
      return tail.length === 0 ? real : join(real, ...tail);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw escapeError();
      }
      const parent = dirname(probe);
      if (parent === probe) throw escapeError();
      const part = basename(probe);
      if (part.length === 0) throw escapeError();
      tail.unshift(part);
      probe = parent;
    }
  }
}

function assertWritable(ctx: ToolContext): void {
  // 未设置或非法值都按 read-only，绝不因为配置缺失而放行写操作。
  if (ctx.permission !== "workspace-write") {
    throw new ContractError(
      ERROR_CODES.E_COMMAND_DENIED,
      "write access denied by read-only permission",
    );
  }
}

/**
 * 解析并校验工具路径。
 * access='write' 时先检查权限，再做与读路径相同的 realpath 校验。
 */
export function resolveWorkspacePath(
  ctx: ToolContext,
  rawPath: string,
  access: PathAccess = "read",
): string {
  if (access === "write") assertWritable(ctx);
  const root = getRoot(ctx);
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    throw new ContractError(ERROR_CODES.E_INVALID_ARGUMENT, "path is required");
  }
  if (rawPath.includes("\0")) throw escapeError();

  // 原文与每一层解码后的形态都要过一遍；编码变体不能成为绕过手段。
  const candidates = [rawPath, ...decodeLayers(rawPath)];
  let firstResolved: string | null = null;
  for (const candidate of candidates) {
    if (candidate.includes("\0")) throw escapeError();
    assertNotUncLike(candidate);
    const absolute = resolve(root.path, candidate);
    const canonical = canonicalizeExistingAncestor(absolute);
    if (!isInside(root.key, normalizeKey(canonical))) throw escapeError();
    if (firstResolved === null) firstResolved = canonical;
  }
  if (firstResolved === null) throw escapeError();
  return firstResolved;
}

// ── 命令硬拒绝 ───────────────────────────────────────────────────

function deny(reason: string): ContractError {
  return new ContractError(ERROR_CODES.E_COMMAND_DENIED, `command denied: ${reason}`);
}

function commandStem(command: string): string {
  const normalized = command.replace(/\\/g, "/");
  let base = basename(normalized).trim();
  base = base.replace(/^[\s"'@(]+/, "").replace(/["')]+$/, "");
  return base.replace(/\.(exe|com|bat|cmd|ps1)$/i, "").toLowerCase();
}

function isSwitchToken(token: string): boolean {
  // `--` 由调用方单独处理（其后全部按路径）。
  if (token.length <= 1) return false;
  if (isWindows) {
    // Windows 删除族的开关是 /s /q；- 开头的 token 是文件名，必须当路径校验。
    return token.startsWith("/");
  }
  // POSIX 的 / 是绝对路径，不能当开关。
  return token.startsWith("-");
}

function isCipherWipeToken(token: string): boolean {
  return /^\/w(?::|$)/i.test(token);
}

/** powershell/pwsh 的 -EncodedCommand 及其缩写（-e、-ec、-enc…）。 */
function isEncodedCommandToken(token: string): boolean {
  if (!/^-{1,2}/.test(token)) return false;
  const body =
    token
      .replace(/^-{1,2}/, "")
      .split(/[:=]/, 1)[0]
      ?.toLowerCase() ?? "";
  return body.length >= 1 && "encodedcommand".startsWith(body);
}

/** powershell/pwsh 的 -Command 及其缩写（-c、-co、-com…）。 */
function isPowerShellCommandToken(token: string): boolean {
  if (!/^-{1,2}/.test(token)) return false;
  const body =
    token
      .replace(/^-{1,2}/, "")
      .split(/[:=]/, 1)[0]
      ?.toLowerCase() ?? "";
  return body.length >= 1 && "command".startsWith(body);
}

function isShellScriptSwitch(token: string): boolean {
  // sh/bash 的 -c、-lc、--command 等；只接受带 c 的短开关。
  return /^-{1,2}[a-z]*c[a-z]*$/i.test(token);
}

/** 从 cmd /c、sh -c、powershell -Command 中取出命令串；非 shell 调用返回 null。 */
function extractShellScript(stem: string, argv: string[]): string | null {
  const rest = argv.slice(1);
  if (stem === "cmd") {
    const index = rest.findIndex((token) => /^[\/-][ck]$/i.test(token));
    return index >= 0 ? rest.slice(index + 1).join(" ") : null;
  }
  if (POWERSHELL_STEMS.has(stem)) {
    const index = rest.findIndex(isPowerShellCommandToken);
    return index >= 0 ? rest.slice(index + 1).join(" ") : null;
  }
  if (SHELL_COMMAND_STEMS.has(stem)) {
    const index = rest.findIndex(isShellScriptSwitch);
    return index >= 0 ? rest.slice(index + 1).join(" ") : null;
  }
  return null;
}

/** 极简 shell 分词：只用于拒绝判断，去掉引号并按 & ; | 分段。 */
function tokenizeShellScript(script: string): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];
  let token = "";
  let quote: '"' | "'" | null = null;

  const flushToken = (): void => {
    if (token.length > 0) {
      current.push(token);
      token = "";
    }
  };
  const flushSegment = (): void => {
    flushToken();
    if (current.length > 0) segments.push(current);
    current = [];
  };

  for (const char of script) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else token += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      flushToken();
      continue;
    }
    if (char === "&" || char === ";" || char === "|") {
      flushSegment();
      continue;
    }
    token += char;
  }
  flushSegment();
  return segments;
}

/**
 * 检查 shell 命令串里的硬拒绝命令。
 * 被 shell 包裹的删除族一律拒绝：在 cmd.exe/powershell 的引号、变量展开、
 * 重定向语法下，参数级路径解析无法可靠证明“删除目标在工作区内”。
 *
 * 这里对整串的每个 token 都做匹配（而不是只看段首），宁可误拒
 * `echo format`，也不放过 `cmd /c powershell -Command Remove-Item ...`
 * 这类嵌套包装。解释器内部自行删除仍无法覆盖（见 decisions）。
 */
function assertShellScriptAllowed(script: string): void {
  if (script.includes("|")) {
    throw deny("piped shell command");
  }
  const tokens = tokenizeShellScript(script).flat();
  const hasReg = tokens.some((token) => commandStem(token) === "reg");
  const hasDeleteArg = tokens.some((token) => token.toLowerCase() === "delete");
  const hasCipherWipe = tokens.some(isCipherWipeToken);
  const hasEncoded = tokens.some(isEncodedCommandToken);

  for (const token of tokens) {
    const stem = commandStem(token);
    if (DENIED_COMMAND_STEMS.has(stem)) throw deny(`${stem} is not allowed`);
    if (hasReg && hasDeleteArg) throw deny("reg delete is not allowed");
    if (stem === "cipher" && hasCipherWipe) throw deny("cipher /w is not allowed");
    if (POWERSHELL_STEMS.has(stem) && hasEncoded) {
      throw deny("powershell -EncodedCommand is not allowed");
    }
    if (SHELL_DELETE_COMMAND_STEMS.has(stem)) {
      throw deny("shell-wrapped delete is not allowed");
    }
  }
}

function assertDeletionTargetsInside(ctx: ToolContext, argv: string[]): void {
  let endOfOptions = false;
  for (const token of argv.slice(1)) {
    if (token.length === 0) continue;
    if (!endOfOptions && token === "--") {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && isSwitchToken(token)) continue;
    // 删除族的所有非开关参数都按路径处理；通配符/变量按字面量解析，
    // 能解析的逃逸（..、绝对路径、UNC）都会在这里被拒。
    let resolved: string;
    try {
      resolved = resolveWorkspacePath(ctx, token, "write");
    } catch (error) {
      if (error instanceof ContractError && error.code === ERROR_CODES.E_WORKSPACE_ESCAPE) {
        // 命令硬拒绝统一使用 E_COMMAND_DENIED，便于上层按策略拒绝处理。
        throw deny("delete target outside workspace");
      }
      throw error;
    }
    if (normalizeKey(resolved) === getRoot(ctx).key) {
      // 允许删除工作区内文件，但不允许把工作区根自己交给删除族。
      throw deny("delete workspace root is not allowed");
    }
  }
}

/**
 * 绝对路径命令不存在时交给 spawn 报 ENOENT，以保留 M3-01 的 E_NOT_FOUND 语义。
 * 不存在的命令不可能产生副作用，因此不算绕过白名单。
 */
function isMissingAbsoluteCommand(command: string): boolean {
  if (!isAbsolute(command)) return false;
  try {
    return !statSync(command).isFile();
  } catch {
    return true;
  }
}

/** argv 级硬拒绝：全部检查通过才允许 spawn。 */
function assertCommandAllowed(ctx: ToolContext, argv: string[]): void {
  const first = argv[0];
  if (first === undefined) {
    throw new ContractError(ERROR_CODES.E_INVALID_ARGUMENT, "argv must not be empty");
  }
  const stem = commandStem(first);

  // 白名单是第一道闸；清单内命令仍需过下面的既有硬拒绝与 shell 串检查。
  const allowed = new Set((ctx.allowedCommands ?? DEFAULT_ALLOWED_COMMANDS).map(commandStem));
  if (!allowed.has(stem) && !isMissingAbsoluteCommand(first)) {
    throw deny(`command is not in the allowlist: ${stem}`);
  }

  if (DENIED_COMMAND_STEMS.has(stem)) throw deny(`${stem} is not allowed`);
  if (stem === "reg" && argv.slice(1).some((token) => token.toLowerCase() === "delete")) {
    throw deny("reg delete is not allowed");
  }
  if (stem === "cipher" && argv.slice(1).some(isCipherWipeToken)) {
    throw deny("cipher /w is not allowed");
  }
  if ((stem === "powershell" || stem === "pwsh") && argv.slice(1).some(isEncodedCommandToken)) {
    throw deny("powershell -EncodedCommand is not allowed");
  }

  const script = extractShellScript(stem, argv);
  if (script !== null) assertShellScriptAllowed(script);

  if (DELETE_COMMAND_STEMS.has(stem)) assertDeletionTargetsInside(ctx, argv);
}

// ── 输出截断与落盘 ───────────────────────────────────────────────

interface TruncatedOutput {
  output: string;
  truncated: boolean;
  originalBytes: number;
}

function truncateText(text: string, maxBytes: number): TruncatedOutput {
  const originalBytes = Buffer.byteLength(text, "utf8");
  if (originalBytes <= maxBytes) {
    return { output: text, truncated: false, originalBytes };
  }
  const marker = `\n…[输出已截断 / output truncated: ${originalBytes} bytes total; showing head and tail]…\n`;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (maxBytes <= markerBytes + 2) {
    return { output: marker, truncated: true, originalBytes };
  }
  const remaining = maxBytes - markerBytes;
  const headBytes = Math.floor(remaining / 2);
  const tailBytes = remaining - headBytes;
  const buffer = Buffer.from(text, "utf8");
  const head = buffer.subarray(0, headBytes).toString("utf8");
  const tail = buffer.subarray(buffer.length - tailBytes).toString("utf8");
  return { output: head + marker + tail, truncated: true, originalBytes };
}

function sanitizeSegment(input: string): string {
  const safe = input.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  return safe.length > 0 ? safe : "_";
}

function outputRoot(ctx: ToolContext): string {
  return ctx.outputDir === undefined
    ? resolve(process.cwd(), "data", "tool-outputs")
    : resolve(ctx.outputDir);
}

function runOutputDir(ctx: ToolContext): string {
  return join(outputRoot(ctx), sanitizeSegment(ctx.runId ?? "no-run"));
}

interface PersistedOutput {
  path: string;
  bytes: number;
}

function persistBuffer(buffer: Buffer, ctx: ToolContext, toolName: string): PersistedOutput {
  const dir = runOutputDir(ctx);
  mkdirSync(dir, { recursive: true });
  const file = join(
    dir,
    `${Date.now()}-${sanitizeSegment(toolName)}-${randomUUID().slice(0, 8)}.log`,
  );
  writeFileSync(file, buffer);
  return { path: file, bytes: buffer.length };
}

function normalizeMaxBytes(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_MAX_OUTPUT_BYTES;
}

function normalizeTimeout(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_TOOL_TIMEOUT_MS;
}

function elapsedMs(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 1)}…`;
}

// ── 事件留痕 ─────────────────────────────────────────────────────

function previewArgs(args: unknown): string {
  let text: string;
  try {
    const json = JSON.stringify(args, (key, value) =>
      SECRET_KEY_RE.test(key) ? "[redacted]" : value,
    );
    text = json === undefined ? "[undefined]" : json;
  } catch {
    text = "[unserializable args]";
  }
  return clip(text, MAX_ARGS_PREVIEW_CHARS);
}

function eventTaskFields(ctx: ToolContext): { taskId: string | null; runId: string | null } {
  return { taskId: ctx.taskId ?? null, runId: ctx.runId ?? null };
}

function appendToolCall(ctx: ToolContext, tool: string, args: unknown): void {
  appendEvent(ctx.db, {
    ...eventTaskFields(ctx),
    type: "agent.tool_call",
    actor: "agent",
    payload: { tool, args_preview: previewArgs(args) },
  });
}

function appendToolResult(ctx: ToolContext, result: ToolResult): void {
  appendEvent(ctx.db, {
    ...eventTaskFields(ctx),
    type: "agent.tool_result",
    actor: "system",
    payload: {
      ok: result.ok,
      preview: clip(result.preview, MAX_EVENT_PREVIEW_CHARS),
      ms: result.ms,
      ...(result.code === undefined ? {} : { code: result.code }),
      ...(result.sha256 === undefined ? {} : { sha256: result.sha256 }),
      ...(result.bytes === undefined ? {} : { bytes: result.bytes }),
    },
  });
}

// ── 内建工具实现 ─────────────────────────────────────────────────

export interface ToolExecution {
  ok: boolean;
  output: string;
  preview?: string;
  code?: ToolErrorCode;
  exitCode?: number | null;
  truncated?: boolean;
  fullOutputPath?: string;
  fullOutputBytes?: number;
  sha256?: string;
  bytes?: number;
}

export interface ToolHandler {
  (ctx: ToolContext, args: unknown): Promise<ToolExecution> | ToolExecution;
}

export interface ToolRegistration {
  spec: ToolSpec;
  handler: ToolHandler;
}

const toolRegistry = new Map<string, ToolRegistration>();

/** 工具模块向唯一注册表登记；同名工具保留先登记者。 */
export function registerTool(registration: ToolRegistration): void {
  if (!toolRegistry.has(registration.spec.name)) {
    toolRegistry.set(registration.spec.name, registration);
  }
}

function asRecord(args: unknown): Record<string, unknown> | null {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return null;
  return args as Record<string, unknown>;
}

function invalid(message: string): ToolExecution {
  return { ok: false, code: ERROR_CODES.E_INVALID_ARGUMENT, output: message, preview: message };
}

export function readFileTool(ctx: ToolContext, args: unknown): ToolExecution {
  const record = asRecord(args);
  if (record === null) return invalid("read_file expects an object argument");

  const rawPath = record.path;
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    return invalid("read_file requires a non-empty path");
  }

  let offset = 0;
  if (record.offset !== undefined) {
    if (
      typeof record.offset !== "number" ||
      !Number.isInteger(record.offset) ||
      record.offset < 0
    ) {
      return invalid("offset must be a non-negative integer");
    }
    offset = record.offset;
  }

  let limit: number | undefined;
  if (record.limit !== undefined) {
    if (typeof record.limit !== "number" || !Number.isInteger(record.limit) || record.limit < 0) {
      return invalid("limit must be a non-negative integer");
    }
    limit = record.limit;
  }

  const path = resolveWorkspacePath(ctx, rawPath, "read");
  let content: Buffer;
  try {
    content = readFileSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return {
        ok: false,
        code: ERROR_CODES.E_NOT_FOUND,
        output: "file not found",
        preview: "file not found",
      };
    }
    return {
      ok: false,
      code: ERROR_CODES.E_INTERNAL,
      output: "file could not be read",
      preview: "file could not be read",
    };
  }

  const text = content.toString("utf8");
  const sliced = limit === undefined ? text.slice(offset) : text.slice(offset, offset + limit);
  const truncated = truncateText(sliced, normalizeMaxBytes(ctx.maxOutputBytes));
  const persisted = truncated.truncated
    ? persistBuffer(Buffer.from(sliced, "utf8"), ctx, "read_file")
    : null;

  return {
    ok: true,
    output: truncated.output,
    truncated: truncated.truncated,
    fullOutputBytes: truncated.originalBytes,
    ...(persisted === null ? {} : { fullOutputPath: persisted.path }),
  };
}

interface CommandOutputFiles {
  stdoutPath: string;
  stderrPath: string;
  stdoutFd: number;
  stderrFd: number;
}

function prepareCommandOutput(ctx: ToolContext): CommandOutputFiles {
  const dir = runOutputDir(ctx);
  mkdirSync(dir, { recursive: true });
  const base = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const stdoutPath = join(dir, `${base}.stdout.tmp`);
  const stderrPath = join(dir, `${base}.stderr.tmp`);
  const stdoutFd = openSync(stdoutPath, "w");
  let stderrFd: number;
  try {
    stderrFd = openSync(stderrPath, "w");
  } catch (error) {
    closeSync(stdoutFd);
    throw error;
  }
  return { stdoutPath, stderrPath, stdoutFd, stderrFd };
}

function readAndMergeOutput(files: CommandOutputFiles): Buffer {
  const stdout = readFileSync(files.stdoutPath);
  const stderr = readFileSync(files.stderrPath);
  return Buffer.concat([stdout, stderr]);
}

function removeFileQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // 清理失败不改变工具结果；临时文件仍在注入的输出目录内。
  }
}

function closeFdQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // 已经关闭或子进程已退出，忽略。
  }
}

function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) {
    try {
      child.kill("SIGKILL");
    } catch {
      // 进程已经退出。
    }
    return;
  }

  if (!isWindows) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // 进程已经退出。
      }
    }
    return;
  }

  let killed = false;
  try {
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killed = result.status === 0;
  } catch {
    killed = false;
  }
  if (!killed) {
    // 受限环境可能不允许 taskkill；至少终止直接子进程。
    try {
      child.kill("SIGKILL");
    } catch {
      // 进程已经退出。
    }
  }
}

function commandFailure(message: string, code: ToolErrorCode): ToolExecution {
  return { ok: false, code, output: message, preview: message };
}

function runCommandProcess(ctx: ToolContext, argv: string[], cwd: string): Promise<ToolExecution> {
  let files: CommandOutputFiles;
  try {
    files = prepareCommandOutput(ctx);
  } catch {
    return Promise.resolve(
      commandFailure("tool output directory is not writable", ERROR_CODES.E_INTERNAL),
    );
  }

  const timeoutMs = normalizeTimeout(ctx.timeoutMs);
  const maxBytes = normalizeMaxBytes(ctx.maxOutputBytes);
  let child: ChildProcess;
  try {
    child = spawn(argv[0] as string, argv.slice(1), {
      cwd,
      env: ctx.env ?? process.env,
      shell: false,
      windowsHide: true,
      detached: !isWindows,
      stdio: ["ignore", files.stdoutFd, files.stderrFd],
    });
  } catch {
    closeFdQuietly(files.stdoutFd);
    closeFdQuietly(files.stderrFd);
    removeFileQuietly(files.stdoutPath);
    removeFileQuietly(files.stderrPath);
    return Promise.resolve(commandFailure("command could not be started", ERROR_CODES.E_INTERNAL));
  }

  return new Promise<ToolExecution>((resolvePromise, rejectPromise) => {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    let fdsClosed = false;

    const closeOutputFiles = (): void => {
      if (fdsClosed) return;
      fdsClosed = true;
      closeFdQuietly(files.stdoutFd);
      closeFdQuietly(files.stderrFd);
    };

    const cleanup = (): void => {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      ctx.signal?.removeEventListener("abort", onAbort);
      closeOutputFiles();
      removeFileQuietly(files.stdoutPath);
      removeFileQuietly(files.stderrPath);
    };

    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };

    const timeOut = (): void => {
      settle(() => {
        rejectPromise(
          new ContractError(ERROR_CODES.E_TOOL_TIMEOUT, `tool timed out after ${timeoutMs}ms`),
        );
      });
    };

    const onAbort = (): void => {
      if (settled) return;
      aborted = true;
      killProcessTree(child);
      forceTimer = setTimeout(() => {
        settle(() => {
          rejectPromise(new ContractError(ERROR_CODES.E_COMMAND_DENIED, "tool execution aborted"));
        });
      }, KILL_GRACE_MS);
    };

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
      forceTimer = setTimeout(timeOut, KILL_GRACE_MS);
    }, timeoutMs);

    ctx.signal?.addEventListener("abort", onAbort, { once: true });
    if (ctx.signal?.aborted === true) onAbort();

    child.once("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      settle(() => {
        resolvePromise(
          commandFailure(
            "command could not be started",
            code === "ENOENT" ? ERROR_CODES.E_NOT_FOUND : ERROR_CODES.E_INTERNAL,
          ),
        );
      });
    });

    child.once("close", (exitCode) => {
      closeOutputFiles();
      if (timedOut) {
        timeOut();
        return;
      }
      if (aborted) {
        settle(() => {
          rejectPromise(new ContractError(ERROR_CODES.E_COMMAND_DENIED, "tool execution aborted"));
        });
        return;
      }

      let combined: Buffer;
      try {
        combined = readAndMergeOutput(files);
      } catch {
        settle(() => {
          rejectPromise(new ContractError(ERROR_CODES.E_INTERNAL, "tool output could not be read"));
        });
        return;
      }

      let persisted: PersistedOutput;
      try {
        persisted = persistBuffer(combined, ctx, "run_command");
      } catch {
        settle(() => {
          rejectPromise(
            new ContractError(ERROR_CODES.E_INTERNAL, "tool output could not be persisted"),
          );
        });
        return;
      }

      const text = combined.toString("utf8");
      const truncated = truncateText(text, maxBytes);
      settle(() => {
        resolvePromise({
          ok: exitCode === 0,
          output: truncated.output,
          exitCode,
          truncated: truncated.truncated,
          fullOutputPath: persisted.path,
          fullOutputBytes: persisted.bytes,
          ...(exitCode === 0 ? {} : { code: TOOL_ERROR_CODES.E_TOOL_EXIT }),
        });
      });
    });
  });
}

export function runCommandTool(ctx: ToolContext, args: unknown): Promise<ToolExecution> {
  if (ctx.permission !== "workspace-write") {
    throw new ContractError(
      ERROR_CODES.E_COMMAND_DENIED,
      "command execution denied by read-only permission",
    );
  }
  const record = asRecord(args);
  if (record === null) {
    return Promise.resolve(invalid("run_command expects an object argument"));
  }
  const argv = record.argv;
  if (
    !Array.isArray(argv) ||
    argv.length === 0 ||
    !argv.every((item) => typeof item === "string" && item.length > 0 && !item.includes("\0"))
  ) {
    return Promise.resolve(invalid("argv must be a non-empty array of non-empty strings"));
  }
  for (const item of argv) {
    if (item.trim().length === 0) {
      return Promise.resolve(invalid("argv entries must not be blank"));
    }
  }

  const commandArgv = argv as string[];
  // 硬拒绝先于 cwd 解析：危险命令无论 cwd 是否合法都直接拒。
  assertCommandAllowed(ctx, commandArgv);

  let cwd = getRoot(ctx).path;
  if (record.cwd !== undefined) {
    if (typeof record.cwd !== "string" || record.cwd.length === 0) {
      return Promise.resolve(invalid("cwd must be a non-empty string"));
    }
    const resolvedCwd = resolveWorkspacePath(ctx, record.cwd, "read");
    try {
      if (!statSync(resolvedCwd).isDirectory()) {
        return Promise.resolve(invalid("cwd is not a directory"));
      }
    } catch {
      return Promise.resolve(commandFailure("cwd does not exist", ERROR_CODES.E_NOT_FOUND));
    }
    cwd = resolvedCwd;
  }

  return runCommandProcess(ctx, commandArgv, cwd);
}

/**
 * 首次调用时才登记内建工具，避免模块循环求值期间读取未初始化的常量。
 * 注册表是唯一的分发依据；executeTool 仍是唯一出口。
 */
let toolsRegistered = false;

function ensureToolsRegistered(): void {
  if (toolsRegistered) return;
  registerFsTools();
  registerShellTools();
  toolsRegistered = true;
}

function dispatchTool(
  ctx: ToolContext,
  name: string,
  args: unknown,
): Promise<ToolExecution> | ToolExecution {
  ensureToolsRegistered();
  const registration = toolRegistry.get(name);
  if (registration === undefined) return invalid("unknown tool");
  return registration.handler(ctx, args);
}

// ── 单一出口 ─────────────────────────────────────────────────────

function toContractError(error: unknown): ContractError {
  if (error instanceof ContractError) return error;
  // 未知异常不回显原始 message，避免把路径/key 带进上层或事件。
  return new ContractError(ERROR_CODES.E_INTERNAL, "tool execution failed");
}

/**
 * 所有工具调用的唯一入口。
 *
 * 正常执行失败（非零退出、文件不存在、参数非法）以结构化结果返回；
 * 安全策略失败（路径逃逸、硬拒绝、只读、超时、取消）抛 ContractError。
 * 无论走哪条路径，都恰好写一对 agent.tool_call + agent.tool_result。
 */
export async function executeTool(
  name: string,
  args: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const started = performance.now();
  const toolName = typeof name === "string" ? name : String(name);

  appendToolCall(ctx, toolName, args);

  if (ctx.signal?.aborted === true) {
    const ms = elapsedMs(started);
    const aborted = new ContractError(ERROR_CODES.E_COMMAND_DENIED, "tool execution aborted");
    const failed: ToolResult = {
      ok: false,
      tool: toolName,
      output: aborted.message,
      preview: aborted.message,
      ms,
      durationMs: ms,
      code: aborted.code,
      error: { code: aborted.code, message: aborted.message },
      truncated: false,
    };
    appendToolResult(ctx, failed);
    throw aborted;
  }

  let execution: ToolExecution;
  try {
    execution = await dispatchTool(ctx, toolName, args);
  } catch (error) {
    const contract = toContractError(error);
    const ms = elapsedMs(started);
    const message = contract.message.length > 0 ? contract.message : contract.code;
    const failed: ToolResult = {
      ok: false,
      tool: toolName,
      output: message,
      preview: message,
      ms,
      durationMs: ms,
      code: contract.code,
      error: { code: contract.code, message },
      truncated: false,
    };
    appendToolResult(ctx, failed);
    throw contract;
  }

  const ms = elapsedMs(started);
  const preview =
    execution.preview === undefined
      ? clip(execution.output, MAX_EVENT_PREVIEW_CHARS)
      : clip(execution.preview, MAX_EVENT_PREVIEW_CHARS);
  const result: ToolResult = {
    ok: execution.ok,
    tool: toolName,
    output: execution.output,
    preview,
    ms,
    durationMs: ms,
    ...(execution.code === undefined ? {} : { code: execution.code }),
    ...(execution.code === undefined
      ? {}
      : {
          error: {
            code: execution.code,
            message:
              execution.code === TOOL_ERROR_CODES.E_TOOL_EXIT
                ? `command exited with code ${String(execution.exitCode)}`
                : clip(
                    execution.preview || execution.output || String(execution.code),
                    MAX_EVENT_PREVIEW_CHARS,
                  ),
          },
        }),
    ...(execution.exitCode === undefined ? {} : { exitCode: execution.exitCode }),
    truncated: execution.truncated ?? false,
    ...(execution.fullOutputPath === undefined ? {} : { fullOutputPath: execution.fullOutputPath }),
    ...(execution.fullOutputBytes === undefined
      ? {}
      : { fullOutputBytes: execution.fullOutputBytes }),
    ...(execution.sha256 === undefined ? {} : { sha256: execution.sha256 }),
    ...(execution.bytes === undefined ? {} : { bytes: execution.bytes }),
  };
  appendToolResult(ctx, result);
  return result;
}
