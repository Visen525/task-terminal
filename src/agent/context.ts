/**
 * 上下文组装（SPEC §4.7 / §7 M5-02）。
 *
 * 主线上下文 = 系统提示 + 长期事实 + 任务看板 + 相关产物摘要 + 最近对话窗口。
 * 子智能体上下文 = 自身 goal + 权限卡 + 最多 3 条父任务产物摘要。
 *
 * 三条硬规则在本文件的落点：
 *   1. 主线只看产物摘要：related 只取 title / summary / tags，绝不把 path、sha256、
 *      findings 或正文带进上下文；正文只能经 read_artifact 显式读取。
 *   2. 看板每任务一行；活动任务超过 30 个时退化为一条按状态汇总的线。
 *   3. 子智能体只看自己那摊事：不携带主线上文，上游摘要硬上限 3 条。
 *
 * 历史窗口的偏差（见 docs/decisions.md）：超出 12 轮的旧对话不做 LLM 摘要，
 * 只折成一行「[已省略 N 轮更早对话]」标记；这是可逆决策，将来可替换为摘要调用。
 */
import type { DatabaseSync } from 'node:sqlite';

import { isTerminalTaskStatus } from '../core/state.ts';
import {
  TASK_STATUSES,
  type LlmMessage,
  type Task,
  type TaskStatus,
} from '../core/types.ts';
import { searchArtifacts } from '../store/artifacts.ts';
import { recallFacts, type Fact } from '../store/facts.ts';
import { listRecentMessages, type Message, type MessageAttachment } from '../store/messages.ts';
import { getTask } from '../store/repo.ts';
import { buildAgentPrompt } from './prompt.ts';

export const DEFAULT_MAIN_HISTORY_LIMIT = 12;
export const DEFAULT_MAIN_FACTS_LIMIT = 20;
export const DEFAULT_RELATED_ARTIFACT_LIMIT = 5;
/** 相关产物检索只取最近一条用户消息的前 50 个字符。 */
export const RELATED_QUERY_MAX_CHARS = 50;
/** 活动任务不超过该值时逐任务列出一行；超过则按状态汇总。 */
export const BOARD_DETAIL_LIMIT = 30;
/** 子智能体最多看到的上游产物摘要条数。 */
export const MAX_UPSTREAM_SUMMARIES = 3;

/** 看板明细里的一行。 */
export interface BoardTaskLine {
  id: string;
  title: string;
  status: TaskStatus;
  artifactCount: number;
}

export interface BoardStatusCount {
  status: TaskStatus;
  count: number;
}

/**
 * 看板上下文：任务数 <= BOARD_DETAIL_LIMIT 时 tasks 有值、summary 为 null；
 * 超过阈值时 tasks 为空、summary 为各活动状态的计数。
 */
export interface BoardContext {
  total: number;
  tasks: BoardTaskLine[];
  summary: BoardStatusCount[] | null;
}

/** 相关产物只保留可安全进入上下文的三个检索字段。 */
export interface RelatedArtifactBrief {
  title: string;
  summary: string;
  tags: string[];
}

export interface GatherMainContextOptions {
  /** 最近一条用户消息，用于 related 检索。 */
  userMessage: string;
  /** 最近对话轮数（user+assistant 为一轮）；默认 12。 */
  historyLimit?: number;
  /** 长期事实条数上限；默认 20。 */
  factsLimit?: number;
}

export interface GatheredMainContext {
  /** 已按轮数裁剪后的最近对话，只含 user / assistant。 */
  history: Message[];
  /** >0 时在系统提示里输出一行省略标记。 */
  omittedHistoryTurns: number;
  facts: Fact[];
  board: BoardContext;
  related: RelatedArtifactBrief[];
}

export interface BuildMainContextInput {
  history: readonly Message[];
  facts: readonly Fact[];
  board: BoardContext;
  related: readonly RelatedArtifactBrief[];
  systemPrompt: string;
  /** 由 gatherMainContext 提供；省略视为没有更早对话。 */
  omittedHistoryTurns?: number;
}

export interface BuildAgentContextOptions {
  upstreamSummaries?: readonly string[];
}

interface CountRow {
  n: number | bigint;
}

interface BoardTaskRow {
  id: string;
  title: string;
  status: string;
}

interface BoardStatusRow {
  status: string;
  n: number | bigint;
}

interface ArtifactCountRow {
  task_id: string;
  n: number | bigint;
}

interface SummaryRow {
  summary: string;
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function activeStatuses(): TaskStatus[] {
  return TASK_STATUSES.filter((status) => !isTerminalTaskStatus(status));
}

function terminalStatusesSql(): { placeholders: string; params: string[] } {
  const terminal = TASK_STATUSES.filter((status) => isTerminalTaskStatus(status));
  return {
    placeholders: terminal.map(() => '?').join(', '),
    params: terminal,
  };
}

/** 活动任务数（completed / cancelled 之外）。 */
function countActiveTasks(db: DatabaseSync): number {
  const terminal = terminalStatusesSql();
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status NOT IN (${terminal.placeholders})`)
    .get(...terminal.params) as unknown as CountRow | undefined;
  return Number(row?.n ?? 0);
}

function readBoardTaskRows(db: DatabaseSync): BoardTaskRow[] {
  const terminal = terminalStatusesSql();
  return db
    .prepare(
      `SELECT id, title, status FROM tasks
        WHERE status NOT IN (${terminal.placeholders})
        ORDER BY created_at ASC, rowid ASC`,
    )
    .all(...terminal.params) as unknown as BoardTaskRow[];
}

function readArtifactCounts(
  db: DatabaseSync,
  taskIds: readonly string[],
): Map<string, number> {
  const counts = new Map<string, number>();
  if (taskIds.length === 0) return counts;
  const placeholders = taskIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT task_id, COUNT(*) AS n FROM artifacts
        WHERE task_id IN (${placeholders})
        GROUP BY task_id`,
    )
    .all(...taskIds) as unknown as ArtifactCountRow[];
  for (const row of rows) counts.set(row.task_id, Number(row.n));
  return counts;
}

/** 采集看板：每任务一行，任务过多时改为按状态汇总（不展开任务）。 */
function gatherBoard(db: DatabaseSync): BoardContext {
  const total = countActiveTasks(db);
  if (total > BOARD_DETAIL_LIMIT) {
    const terminal = terminalStatusesSql();
    const rows = db
      .prepare(
        `SELECT status, COUNT(*) AS n FROM tasks
          WHERE status NOT IN (${terminal.placeholders})
          GROUP BY status`,
      )
      .all(...terminal.params) as unknown as BoardStatusRow[];
    const byStatus = new Map<string, number>();
    for (const row of rows) byStatus.set(row.status, Number(row.n));
    const summary: BoardStatusCount[] = [];
    for (const status of activeStatuses()) {
      const count = byStatus.get(status) ?? 0;
      if (count > 0) summary.push({ status, count });
    }
    return { total, tasks: [], summary };
  }

  const rows = readBoardTaskRows(db);
  const counts = readArtifactCounts(
    db,
    rows.map((row) => row.id),
  );
  const tasks: BoardTaskLine[] = rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status as TaskStatus,
    artifactCount: counts.get(row.id) ?? 0,
  }));
  return { total, tasks, summary: null };
}

/** 相关产物只取检索命中里的摘要字段，path / findings / 正文一律丢弃。 */
function gatherRelated(
  db: DatabaseSync,
  userMessage: string,
): RelatedArtifactBrief[] {
  const query = [...userMessage].slice(0, RELATED_QUERY_MAX_CHARS).join('').trim();
  if (query.length === 0) return [];
  return searchArtifacts(db, { query, limit: DEFAULT_RELATED_ARTIFACT_LIMIT }).map(
    (hit) => ({
      title: hit.title,
      summary: hit.summary,
      tags: [...hit.tags],
    }),
  );
}

/**
 * 取最近 historyLimit 轮对话；总轮数与窗口轮数之差就是省略的轮数。
 * 只统计 user / assistant（主线 messages 也只落这两种角色）。
 */
function gatherHistory(
  db: DatabaseSync,
  historyLimit: number,
): { history: Message[]; omittedHistoryTurns: number } {
  const limit = Math.max(1, historyLimit);
  const totalRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM messages
        WHERE task_id IS NULL AND role IN ('user', 'assistant')`,
    )
    .get() as unknown as CountRow | undefined;
  const totalMessages = Number(totalRow?.n ?? 0);
  const history = listRecentMessages(db, limit * 2).filter(
    (message) => message.role === 'user' || message.role === 'assistant',
  );
  const totalTurns = Math.ceil(totalMessages / 2);
  const keptTurns = Math.ceil(history.length / 2);
  return {
    history,
    omittedHistoryTurns: Math.max(0, totalTurns - keptTurns),
  };
}

/**
 * 采集主线上下文数据（IO）：事实、看板、相关产物、对话窗口。
 * 只读数据库，不做任何拼接；拼接由 buildMainContext 完成。
 */
export function gatherMainContext(
  db: DatabaseSync,
  options: GatherMainContextOptions,
): GatheredMainContext {
  const historyLimit = normalizeLimit(options.historyLimit, DEFAULT_MAIN_HISTORY_LIMIT);
  const factsLimit = normalizeLimit(options.factsLimit, DEFAULT_MAIN_FACTS_LIMIT);
  const history = gatherHistory(db, historyLimit);
  return {
    history: history.history,
    omittedHistoryTurns: history.omittedHistoryTurns,
    facts: recallFacts(db, { limit: factsLimit }),
    board: gatherBoard(db),
    related: gatherRelated(db, options.userMessage),
  };
}

function formatFacts(facts: readonly Fact[]): string {
  return facts
    .map((fact) => `- ${fact.key}: ${fact.value}（置信度 ${fact.confidence}）`)
    .join('\n');
}

function formatBoard(board: BoardContext): string {
  if (board.summary !== null) {
    const parts = board.summary
      .map((entry) => `${entry.status} ${entry.count}`)
      .join(' | ');
    return `[看板汇总] 活动任务 ${board.total} 个 | ${parts}`;
  }
  return board.tasks
    .map(
      (task) =>
        `[${task.id}] ${task.title} | ${task.status} | 产物 ${task.artifactCount}`,
    )
    .join('\n');
}

function formatRelated(related: readonly RelatedArtifactBrief[]): string {
  return related
    .map((artifact) => {
      const tags = artifact.tags.length > 0 ? artifact.tags.join(', ') : '（无）';
      return `- ${artifact.title} | tags: ${tags} | ${artifact.summary}`;
    })
    .join('\n');
}

/**
 * 历史轮的附件折成文字占位：让模型知道"当时看到过图片/文件"，
 * 避免把基于图片的旧回答误判为无依据（图片本体不重发，控 token）。
 * 措辞必须明确"当时已送达查看"，否则模型会把占位当成"从未收到"的证据。
 */
function appendAttachmentMarks(
  text: string,
  attachments: readonly MessageAttachment[] | undefined,
): string {
  if (attachments === undefined || attachments.length === 0) return text;
  const marks = attachments.map((attachment) =>
    attachment.mime.startsWith('image/')
      ? `[图片 ${attachment.name}：当轮已送达并被查看；历史回放不重发原图，基于它的回答有效]`
      : `[附件 ${attachment.name}：当轮内容已内联处理；历史回放不重发原文]`,
  );
  return `${text}\n${marks.join(' ')}`;
}

/**
 * 纯组装：把采集好的块拼成 provider 入参。
 * 空块不输出任何标题，因此没有任何上下文时系统提示与 systemPrompt 逐字相同。
 *
 * @param _db 预留给未来的块级二次查询；当前组装不需要 IO。
 */
export function buildMainContext(
  _db: DatabaseSync,
  input: BuildMainContextInput,
): LlmMessage[] {
  const blocks: string[] = [];
  if (input.facts.length > 0) {
    blocks.push(`## 长期事实\n${formatFacts(input.facts)}`);
  }

  const board = formatBoard(input.board);
  if (board.length > 0) {
    blocks.push(`## 任务看板\n${board}`);
  }

  if (input.related.length > 0) {
    blocks.push(`## 相关产物摘要\n${formatRelated(input.related)}`);
  }

  const omitted = Math.max(0, Math.floor(input.omittedHistoryTurns ?? 0));
  if (omitted > 0) {
    blocks.push(`## 对话历史\n[已省略 ${omitted} 轮更早对话]`);
  }

  const systemContent =
    blocks.length === 0
      ? input.systemPrompt
      : `${input.systemPrompt}\n\n${blocks.join('\n\n')}`;

  const messages: LlmMessage[] = [{ role: 'system', content: systemContent }];
  for (const message of input.history) {
    if (message.role === 'user' || message.role === 'assistant') {
      messages.push({
        role: message.role,
        content: appendAttachmentMarks(message.content, message.attachments),
      });
    }
  }
  return messages;
}

/**
 * 组装子智能体上下文：自身 goal + 工作区/权限卡 + 最多 3 条上游摘要。
 * 只返回一条 system 消息；不携带任何主线上文。
 */
export function buildAgentContext(
  task: Task,
  options: BuildAgentContextOptions = {},
): LlmMessage[] {
  const summaries = (options.upstreamSummaries ?? [])
    .map((summary) => summary.trim())
    .filter((summary) => summary.length > 0)
    .slice(0, MAX_UPSTREAM_SUMMARIES);

  let content = buildAgentPrompt(task, task.permission);
  if (summaries.length > 0) {
    content += `\n\n## 上游任务产物摘要\n${summaries
      .map((summary) => `- ${summary}`)
      .join('\n')}`;
  }
  return [{ role: 'system', content }];
}

/**
 * 取父任务最近的产物摘要（最多 3 条）；没有 parent 或父任务不存在时为空。
 * 只读 summary 列，不读 path / 正文 / 其他字段。
 */
export function gatherAgentContext(db: DatabaseSync, task: Task): string[] {
  if (task.parentId === null) return [];
  if (getTask(db, task.parentId) === null) return [];
  const rows = db
    .prepare(
      `SELECT summary FROM artifacts
        WHERE task_id = ? AND summary <> ''
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?`,
    )
    .all(task.parentId, MAX_UPSTREAM_SUMMARIES) as unknown as SummaryRow[];
  return rows.map((row) => row.summary);
}
