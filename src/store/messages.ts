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

export interface Message {
  id: string;
  taskId: string | null;
  seq: number;
  role: MessageRole;
  content: string;
  tokens: number | null;
  ts: number;
}

export interface NewMessageInput {
  /** NULL/省略 = 主线对话。 */
  taskId?: string | null;
  role: MessageRole;
  content: string;
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

function mapMessage(row: MessageRow): Message {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.content);
  } catch (error) {
    throw new ContractError(
      ERROR_CODES.E_INTERNAL,
      `messages.content 不是合法 JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (typeof parsed !== 'string') {
    throw new ContractError(ERROR_CODES.E_INTERNAL, 'messages.content 应为 JSON 字符串');
  }
  return {
    id: row.id,
    taskId: row.task_id,
    seq: row.seq,
    role: row.role as MessageRole,
    content: parsed,
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

  db.prepare(
    `INSERT INTO messages (id, task_id, seq, role, content, tokens, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, taskId, seq, input.role, JSON.stringify(input.content), tokens, ts);

  return {
    id,
    taskId,
    seq,
    role: input.role,
    content: input.content,
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
