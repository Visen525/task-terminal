/**
 * 产物落盘（SPEC §7 M7-01）。
 *
 * submit_result 通过结构校验后，由 loop 的 onBeforeComplete 钩子调用本模块：
 *   - file / dataset / patch：按工作区路径校验语义读正文，算 sha256 + bytes；
 *   - note：把 artifact.summary + result.findings 写成 Markdown，落 data/artifacts/
 *     （系统受信目录，不走 executeTool 的模型动作沙箱），再算 sha256 + bytes；
 *   - 每个产物经 insertArtifact 写主表 + FTS，随后写 artifact.created 活动事件；
 *   - 全部成功后才写一条 summary.generated，保证它和 artifact.created 都排在
 *     task.completed 之前（foldEvents 只允许活动事件出现在 running 态）。
 *
 * 假完成防御：file 类产物声称的路径不存在（或读失败）时整个调用抛
 * ContractError(E_NOT_FOUND)，由 loop 按 result_invalid 结束任务；所有文件在
 * 任何副作用（写 note / insertArtifact / 事件）之前先统一校验，避免半落盘。
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { ContractError, ERROR_CODES } from "../core/errors.ts";
import { insertArtifact, type Artifact, type ArtifactKind } from "../store/artifacts.ts";
import { appendEvent } from "../store/events.ts";
import { newUlid } from "../store/ulid.ts";
import { createToolContext, resolveWorkspacePath, type ToolContext } from "./executeTool.ts";
import type { SubmitArtifact, SubmitResult } from "./result-validator.ts";

/** note 产物在 artifacts.path 中的逻辑前缀（相对仓库/data 根）。 */
export const ARTIFACT_NOTE_PREFIX = "data/artifacts/";

/** summary.generated 事件的 summary 截断长度，与事件预览的 500 字保持一致。 */
export const SUMMARY_EVENT_MAX_CHARS = 500;

/** 可注入时钟：直接给毫秒时间戳，或给取时间的函数。 */
export type ArtifactClock = number | (() => number);

export interface PersistArtifactsInput {
  taskId: string;
  runId: string | null;
  /** 任务工作区；file/dataset/patch 的 path 在这里校验与读取。 */
  workspace: string;
  result: SubmitResult;
  /** 可注入时钟（毫秒时间戳或函数）；默认 Date.now。 */
  now?: ArtifactClock;
  /**
   * note 文件的实际根目录（默认 <cwd>/data/artifacts）；测试注入临时目录用。
   * 注意 artifacts.path 仍存逻辑相对路径 data/artifacts/<taskId>/<ulid>.md。
   */
  artifactsDir?: string;
}

interface ArtifactPlan {
  source: SubmitArtifact;
  kind: ArtifactKind;
  path: string | null;
  sha256: string | null;
  bytes: number | null;
  findings: string[];
  /** note 专用：文件 ULID 与产物 ID 对齐，便于从文件名回溯产物行。 */
  artifactId: string | null;
  /** note 专用：待写 Markdown 与真实绝对路径。 */
  noteMarkdown: string | null;
  noteFile: string | null;
}

function resolveClock(now: ArtifactClock | undefined): number {
  if (typeof now === "function") return now();
  if (typeof now === "number" && Number.isFinite(now)) return Math.floor(now);
  return Date.now();
}

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 1)}…`;
}

function sanitizeSegment(input: string): string {
  const safe = input.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  return safe.length > 0 ? safe : "_";
}

function noteRoot(artifactsDir: string | undefined): string {
  return artifactsDir === undefined
    ? resolve(process.cwd(), "data", "artifacts")
    : resolve(artifactsDir);
}

/**
 * 把 artifacts.path（逻辑相对路径）映射到 note 的实际文件。
 * 只接受 data/artifacts/ 前缀，并做目录逃逸检查；data/ 是系统受信目录，
 * 因此这里直接用 fs 读取，不再经过 executeTool 的模型动作路径沙箱。
 */
export function resolveArtifactNotePath(artifactPath: string, artifactsDir?: string): string {
  const normalized = artifactPath.replace(/\\/g, "/");
  if (!normalized.startsWith(ARTIFACT_NOTE_PREFIX)) {
    throw new ContractError(
      ERROR_CODES.E_INVALID_ARGUMENT,
      `note 产物路径不在受信目录 ${ARTIFACT_NOTE_PREFIX}: ${artifactPath}`,
    );
  }
  const suffix = normalized.slice(ARTIFACT_NOTE_PREFIX.length);
  const root = noteRoot(artifactsDir);
  const target = resolve(root, suffix);
  const rel = relative(root, target);
  if (
    rel.length === 0 ||
    rel === ".." ||
    rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(rel)
  ) {
    throw new ContractError(
      ERROR_CODES.E_INVALID_ARGUMENT,
      `note 产物路径逃逸受信目录: ${artifactPath}`,
    );
  }
  return target;
}

/** 读取 note 正文；不存在或读失败统一 E_NOT_FOUND（不把绝对路径带进错误信息）。 */
export function readArtifactNoteContent(artifactPath: string, artifactsDir?: string): string {
  const file = resolveArtifactNotePath(artifactPath, artifactsDir);
  try {
    return readFileSync(file, "utf8");
  } catch {
    throw new ContractError(
      ERROR_CODES.E_NOT_FOUND,
      `note 产物文件不存在或不可读: ${artifactPath}`,
    );
  }
}

function sha256Of(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function buildNoteMarkdown(artifact: SubmitArtifact, findings: readonly string[]): string {
  const lines: string[] = [`# ${artifact.title}`, "", artifact.summary.trim(), ""];
  if (findings.length > 0) {
    lines.push("## 关键结论", "");
    for (const finding of findings) lines.push(`- ${finding}`);
    lines.push("");
  }
  return lines.join("\n");
}

function assertTaskExists(db: DatabaseSync, taskId: string): void {
  const row = db.prepare("SELECT id FROM tasks WHERE id = ?").get(taskId);
  if (row === undefined) {
    throw new ContractError(ERROR_CODES.E_NOT_FOUND, `任务不存在: ${taskId}`);
  }
}

/**
 * 只做校验与内容准备，不写任何文件/数据库/事件。
 * 任一 file 路径缺失都让整个 persistArtifacts 在副作用之前失败。
 */
function planArtifacts(
  db: DatabaseSync,
  input: PersistArtifactsInput,
  now: number,
): ArtifactPlan[] {
  const taskId = input.taskId;
  // 只有出现 file/dataset/patch 时才需要工作区；纯 note 落盘不依赖 workspace 存在。
  let ctx: ToolContext | null = null;
  const root = noteRoot(input.artifactsDir);
  const plans: ArtifactPlan[] = [];

  for (const source of input.result.artifacts) {
    if (source.kind === "note") {
      const markdown = buildNoteMarkdown(source, input.result.findings);
      const buffer = Buffer.from(markdown, "utf8");
      const fileId = newUlid(now);
      const relativePath = `${ARTIFACT_NOTE_PREFIX}${sanitizeSegment(taskId)}/${fileId}.md`;
      const file = join(root, sanitizeSegment(taskId), `${fileId}.md`);
      plans.push({
        source,
        kind: "note",
        path: relativePath,
        sha256: sha256Of(buffer),
        bytes: buffer.length,
        findings: [...input.result.findings],
        artifactId: `a_${fileId}`,
        noteMarkdown: markdown,
        noteFile: file,
      });
      continue;
    }

    if (source.path === undefined) {
      throw new ContractError(
        ERROR_CODES.E_INVALID_ARGUMENT,
        `产物 ${source.kind} 必须提供 path（只有 note 可以省略）`,
      );
    }

    ctx ??= createToolContext({
      workspace: input.workspace,
      db,
      taskId,
      runId: input.runId,
      // 路径校验本身按 read 访问执行；permission 只影响 write 分支。
      permission: "workspace-write",
    });
    const resolved = resolveWorkspacePath(ctx, source.path, "read");
    let buffer: Buffer;
    try {
      buffer = readFileSync(resolved);
    } catch {
      // 不吞错：模型声称产出不存在的文件 = 假完成，SPEC 反假完成原则。
      throw new ContractError(ERROR_CODES.E_NOT_FOUND, `产物文件不存在或不可读: ${source.path}`);
    }
    plans.push({
      source,
      kind: source.kind,
      path: source.path,
      sha256: sha256Of(buffer),
      bytes: buffer.length,
      findings: [],
      artifactId: null,
      noteMarkdown: null,
      noteFile: null,
    });
  }

  return plans;
}

/**
 * 把 submit_result.artifacts 全部落盘，并写 artifact.created / summary.generated。
 * 返回本次插入的产物行；调用方（loop 钩子）无需再处理返回值。
 */
export function persistArtifacts(db: DatabaseSync, input: PersistArtifactsInput): Artifact[] {
  const now = resolveClock(input.now);
  assertTaskExists(db, input.taskId);

  // 第一阶段：全部校验/读取/算哈希。任一失败在此抛出，尚无副作用。
  const plans = planArtifacts(db, input, now);

  // 第二阶段：写 note 文件、插 artifacts 主表 + FTS、补活动事件。
  const persisted: Artifact[] = [];
  for (const plan of plans) {
    if (plan.noteMarkdown !== null && plan.noteFile !== null) {
      mkdirSync(dirname(plan.noteFile), { recursive: true });
      writeFileSync(plan.noteFile, plan.noteMarkdown, "utf8");
    }

    const artifact = insertArtifact(db, {
      taskId: input.taskId,
      runId: input.runId,
      ...(plan.artifactId === null ? {} : { id: plan.artifactId }),
      kind: plan.kind,
      title: plan.source.title,
      summary: plan.source.summary,
      tags: plan.source.tags ?? [],
      findings: plan.findings,
      path: plan.path,
      sha256: plan.sha256,
      bytes: plan.bytes,
      now,
    });
    persisted.push(artifact);

    appendEvent(db, {
      taskId: input.taskId,
      runId: input.runId,
      type: "artifact.created",
      actor: "system",
      payload: {
        artifact_id: artifact.id,
        path: artifact.path,
        sha256: artifact.sha256,
      },
      ts: now,
    });
  }

  // 所有 artifact.created 之后再发摘要事件，随后 loop 才写 task.completed。
  appendEvent(db, {
    taskId: input.taskId,
    runId: input.runId,
    type: "summary.generated",
    actor: "system",
    payload: {
      artifact_count: persisted.length,
      summary: clip(input.result.summary, SUMMARY_EVENT_MAX_CHARS),
    },
    ts: now,
  });

  return persisted;
}
