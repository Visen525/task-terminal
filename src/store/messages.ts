/**
 * 主线对话消息仓储（SPEC §4.2 messages / §7 M5-01）。
 *
 * task_id = NULL 表示主线常驻对话；seq 在同一会话内单调递增（主线用
 * IS NULL 作用域）。content 按 SPEC 以 JSON 文本落库，读出时还原为字符串。
 * 本模块只做持久化，不拼模型上下文、不写事件。
 */
import type { DatabaseSync } from 'node:sqlite';

import { ContractError, ERROR_CODES } from '../core/errors.ts';
import { newUlid } from './ulid.ts';

export const MESSAGE_ROLES = ['user', 'assistant', 'tool'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

export const DEFAULT_RECENT_MESSAGES = 20;

/**
 * 对话附件元数据（M9-03 v1.1）。
 * path 是逻辑路径（data/uploads/<ulid>__<safeName>），不是本机绝对路径；
 * 下载始终按 id 在注入的 uploads 根目录定位，避免把个人路径写进消息表/API。
 */
export interface MessageAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  path: string;
}

export interface Message {
  id: string;
  taskId: string | null;
  seq: number;
  role: MessageRole;
  /** 纯文本视图；v1.1 起从 {text,attachments} 或旧版 JSON 字符串解析而来。 */
  content: string;
  /** 仅在消息带附件时出现。 */
  attachments?: MessageAttachment[];
  tokens: number | null;
  ts: number;
}

export interface NewMessageInput {
  /** NULL/省略 = 主线对话。 */
  taskId?: string | null;
  role: MessageRole;
  content: string;
  /** 带附件时按 v1.1 的 {text,attachments} 对象落库；不带时保持旧版 JSON 字符串。 */
  attachments?: readonly MessageAttachment[];
  tokens?: number | null;
  /** 可注入时钟；默认 Date.now()。 */
  ts?: number;
  /** 允许调用方指定 ID（导入/测试用），默认 m_<ulid>。 */
  id?: string;
}

interface MessageRow {
  id: string;
  task_id: string | null;
  seq: number;
  role: string;
  content: string;
  tokens: number | null;
  ts: number;
}

interface StoredContent {
  text: string;
  attachments: MessageAttachment[];
}

function validateAttachment(value: unknown): MessageAttachment {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ContractError(ERROR_CODES.E_INTERNAL, 'messages.content 附件元数据不合法');
  }
  const record = value as Record<string, unknown>;
  const { id, name, mime, path } = record;
  const size = record.size;
  if (
    typeof id !== 'string' ||
    typeof name !== 'string' ||
    typeof mime !== 'string' ||
    typeof path !== 'string' ||
    typeof size !== 'number' ||
    !Number.isFinite(size) ||
    size < 0
  ) {
    throw new ContractError(ERROR_CODES.E_INTERNAL, 'messages.content 附件元数据不合法');
  }
  return { id, name, mime, size: Math.floor(size), path };
}

/**
 * 解析 messages.content：
 *   - v1 及以前是 JSON.stringify(纯文本字符串)；
 *   - v1.1 是 JSON.stringify({ text, attachments? })。
 * 两条路径都归一为 { text, attachments }，读侧不依赖写入版本。
 */
function parseStoredContent(raw: string): StoredContent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ContractError(
      ERROR_CODES.E_INTERNAL,
      `messages.content 不是合法 JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (typeof parsed === 'string') return { text: parsed, attachments: [] };
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ContractError(ERROR_CODES.E_INTERNAL, 'messages.content 格式不合法');
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.text !== 'string') {
    throw new ContractError(ERROR_CODES.E_INTERNAL, 'messages.content.text 应为字符串');
  }
  const rawAttachments = record.attachments;
  if (rawAttachments === undefined) {
    return { text: record.text, attachments: [] };
  }
  if (!Array.isArray(rawAttachments)) {
    throw new ContractError(ERROR_CODES.E_INTERNAL, 'messages.content.attachments 应为数组');
  }
  return {
    text: record.text,
    attachments: rawAttachments.map(validateAttachment),
  };
}

function mapMessage(row: MessageRow): Message {
  const parsed = parseStoredContent(row.content);
  return {
    id: row.id,
    taskId: row.task_id,
    seq: row.seq,
    role: row.role as MessageRole,
    content: parsed.text,
    ...(parsed.attachments.length > 0 ? { attachments: parsed.attachments } : {}),
    tokens: row.tokens,
    ts: row.ts,
  };
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_RECENT_MESSAGES;
  return Math.max(0, Math.floor(limit));
}

function nextSeq(db: DatabaseSync, taskId: string | null): number {
  const row =
    taskId === null
      ? (db
          .prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE task_id IS NULL')
          .get() as unknown as { seq: number | bigint } | undefined)
      : (db
          .prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE task_id = ?')
          .get(taskId) as unknown as { seq: number | bigint } | undefined);
  return Number(row?.seq ?? 0) + 1;
}

/** 追加一条消息，返回落库后的内存视图。 */
export function appendMessage(db: DatabaseSync, input: NewMessageInput): Message {
  if (!(MESSAGE_ROLES as readonly string[]).includes(input.role)) {
    throw new ContractError(
      ERROR_CODES.E_INVALID_ARGUMENT,
      `role 必须是 ${MESSAGE_ROLES.join('|')} 之一`,
    );
  }
  const taskId = input.taskId ?? null;
  const ts = input.ts ?? Date.now();
  const id = input.id ?? `m_${newUlid(ts)}`;
  const seq = nextSeq(db, taskId);
  const tokens =
    input.tokens === undefined || input.tokens === null
      ? null
      : Math.max(0, Math.floor(input.tokens));
  const attachments = (input.attachments ?? []).map((attachment) =>
    validateAttachment(attachment),
  );
  const serializedContent =
    attachments.length > 0
      ? JSON.stringify({ text: input.content, attachments })
      : JSON.stringify(input.content);

  db.prepare(
    `INSERT INTO messages (id, task_id, seq, role, content, tokens, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, taskId, seq, input.role, serializedContent, tokens, ts);

  return {
    id,
    taskId,
    seq,
    role: input.role,
    content: input.content,
    ...(attachments.length > 0 ? { attachments } : {}),
    tokens,
    ts,
  };
}

/**
 * 取主线最近 limit 条消息：先按 seq 降序取，再反转为时间正序。
 * 只返回 task_id IS NULL 的主线消息。
 */
export function listRecentMessages(db: DatabaseSync, limit?: number): Message[] {
  const max = normalizeLimit(limit);
  if (max === 0) return [];
  const rows = db
    .prepare(
      `SELECT * FROM messages
        WHERE task_id IS NULL
        ORDER BY seq DESC
        LIMIT ?`,
    )
    .all(max) as unknown as MessageRow[];
  return rows.reverse().map(mapMessage);
}

/**
 * 按附件 id 查附件元数据（M9-03 GET /uploads/:id 下发 mime 用）。
 * 附件不单独建表，仍以 messages.content 为唯一来源；instr 精确匹配 id，
 * 不拼 LIKE 通配符，避免把用户输入当模式。找不到返回 null。
 */
export function findAttachmentById(
  db: DatabaseSync,
  id: string,
): MessageAttachment | null {
  if (id.length === 0) return null;
  const rows = db
    .prepare(
      `SELECT content FROM messages
        WHERE instr(content, ?) > 0
        ORDER BY seq DESC`,
    )
    .all(id) as unknown as Array<{ content: string }>;
  for (const row of rows) {
    const parsed = parseStoredContent(row.content);
    const match = parsed.attachments.find((attachment) => attachment.id === id);
    if (match !== undefined) return match;
  }
  return null;
}
