/**
 * 事件流（SPEC §4.4 / §7 M1-01）：append-only 写入与按 seq 分页读取。
 * 只做持久化，不解释业务状态；事件折叠见 core/fold.ts。
 */
import type { DatabaseSync } from 'node:sqlite';

import type { EventActor, EventType, JsonValue, TaskEvent } from '../core/types.ts';

interface EventRow {
  seq: number;
  task_id: string | null;
  run_id: string | null;
  ts: number;
  type: string;
  actor: string;
  payload: string;
}

function mapEvent(row: EventRow): TaskEvent {
  return {
    seq: row.seq,
    taskId: row.task_id,
    runId: row.run_id,
    ts: row.ts,
    type: row.type as EventType,
    actor: row.actor as EventActor,
    payload: JSON.parse(row.payload) as JsonValue,
  };
}

export interface NewEventInput {
  taskId?: string | null;
  runId?: string | null;
  type: EventType;
  actor: EventActor;
  payload: JsonValue;
  ts?: number;
}

/** 追加事件，返回全局单调 seq。 */
export function appendEvent(db: DatabaseSync, input: NewEventInput): number {
  const result = db
    .prepare('INSERT INTO events (task_id, run_id, ts, type, actor, payload) VALUES (?, ?, ?, ?, ?, ?)')
    .run(
      input.taskId ?? null,
      input.runId ?? null,
      input.ts ?? Date.now(),
      input.type,
      input.actor,
      JSON.stringify(input.payload),
    );
  return Number(result.lastInsertRowid);
}

export interface ListEventsOptions {
  taskId?: string;
  runId?: string;
  afterSeq?: number;
  limit?: number;
}

/** 按 seq 升序分页读取事件；afterSeq 为上一页最后一条的 seq。 */
export function listEvents(db: DatabaseSync, options: ListEventsOptions = {}): TaskEvent[] {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (options.taskId !== undefined) {
    where.push('task_id = ?');
    params.push(options.taskId);
  }
  if (options.runId !== undefined) {
    where.push('run_id = ?');
    params.push(options.runId);
  }
  if (options.afterSeq !== undefined) {
    where.push('seq > ?');
    params.push(options.afterSeq);
  }
  const limit = options.limit ?? 100;
  const sql = `SELECT * FROM events
    ${where.length > 0 ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY seq ASC LIMIT ?`;
  const rows = db.prepare(sql).all(...params, limit) as unknown as EventRow[];
  return rows.map(mapEvent);
}
