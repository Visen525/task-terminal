/**
 * 仓储层（SPEC §4.2）：tasks / runs / events 的读写。
 * 只做持久化与转移校验，不写事件编排（由 runtime 负责"状态变更同时写事件"）。
 */
import type { DatabaseSync } from 'node:sqlite';

import { ContractError, ERROR_CODES } from '../core/errors.ts';
import {
  assertTransition,
  canRunTransition,
  isTerminalRunStatus,
  isTerminalTaskStatus,
} from '../core/state.ts';
import type {
  EventActor,
  EventType,
  JsonValue,
  PermissionMode,
  RunStatus,
  Task,
  TaskEvent,
  TaskRun,
  TaskStatus,
} from '../core/types.ts';
import { newRunId, newTaskId } from './ulid.ts';

// ── 行类型与映射 ─────────────────────────────────────────────────

interface TaskRow {
  id: string;
  parent_id: string | null;
  title: string;
  goal: string;
  status: string;
  revision: number;
  permission: string;
  workspace: string;
  budget_tokens: number;
  spent_tokens: number;
  result_json: string | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
}

interface RunRow {
  id: string;
  task_id: string;
  attempt: number;
  status: string;
  lease_until: number;
  steps: number;
  error: string | null;
  started_at: number;
  ended_at: number | null;
}

interface EventRow {
  seq: number;
  task_id: string | null;
  run_id: string | null;
  ts: number;
  type: string;
  actor: string;
  payload: string;
}

function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    parentId: row.parent_id,
    title: row.title,
    goal: row.goal,
    status: row.status as TaskStatus,
    revision: row.revision,
    permission: row.permission as PermissionMode,
    workspace: row.workspace,
    budgetTokens: row.budget_tokens,
    spentTokens: row.spent_tokens,
    resultJson: row.result_json,
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

function mapRun(row: RunRow): TaskRun {
  return {
    id: row.id,
    taskId: row.task_id,
    attempt: row.attempt,
    status: row.status as RunStatus,
    leaseUntil: row.lease_until,
    steps: row.steps,
    error: row.error,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
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

// ── tasks ────────────────────────────────────────────────────────

export interface NewTaskInput {
  title: string;
  goal: string;
  workspace: string;
  permission?: PermissionMode;
  parentId?: string | null;
  budgetTokens?: number;
  now?: number;
}

export function insertTask(db: DatabaseSync, input: NewTaskInput): Task {
  const id = newTaskId();
  const createdAt = input.now ?? Date.now();
  db.prepare(
    `INSERT INTO tasks
      (id, parent_id, title, goal, status, revision, permission, workspace,
       budget_tokens, spent_tokens, result_json, created_at, started_at, ended_at)
     VALUES (?, ?, ?, ?, 'queued', 1, ?, ?, ?, 0, NULL, ?, NULL, NULL)`,
  ).run(
    id,
    input.parentId ?? null,
    input.title,
    input.goal,
    input.permission ?? 'workspace-write',
    input.workspace,
    input.budgetTokens ?? 120000,
    createdAt,
  );
  const task = getTask(db, id);
  if (!task) throw new ContractError(ERROR_CODES.E_INTERNAL, `任务插入后读回失败: ${id}`);
  return task;
}

export function getTask(db: DatabaseSync, id: string): Task | null {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as unknown as TaskRow | undefined;
  return row ? mapTask(row) : null;
}

export interface ListTasksOptions {
  status?: TaskStatus;
  limit?: number;
}

export function listTasks(db: DatabaseSync, options: ListTasksOptions = {}): Task[] {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (options.status !== undefined) {
    where.push('status = ?');
    params.push(options.status);
  }
  const limit = options.limit ?? 100;
  const sql = `SELECT * FROM tasks
    ${where.length > 0 ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY created_at ASC LIMIT ?`;
  const rows = db.prepare(sql).all(...params, limit) as unknown as TaskRow[];
  return rows.map(mapTask);
}

export interface UpdateTaskStatusOptions {
  /** CAS：期望的 revision；不匹配抛 E_CONFLICT。 */
  expectedRevision?: number;
  resultJson?: string | null;
  spentTokens?: number;
  now?: number;
}

export function updateTaskStatus(
  db: DatabaseSync,
  id: string,
  status: TaskStatus,
  options: UpdateTaskStatusOptions = {},
): Task {
  const current = getTask(db, id);
  if (!current) throw new ContractError(ERROR_CODES.E_NOT_FOUND, `任务不存在: ${id}`);
  assertTransition(current.status, status);

  const now = options.now ?? Date.now();
  const startedAt = status === 'running' ? (current.startedAt ?? now) : current.startedAt;
  const endedAt = isTerminalTaskStatus(status)
    ? (current.endedAt ?? now)
    : status === 'queued'
      ? null
      : current.endedAt;
  const spentTokens = options.spentTokens ?? current.spentTokens;
  const resultJson = options.resultJson === undefined ? current.resultJson : options.resultJson;

  const assignments =
    'status = ?, revision = revision + 1, started_at = ?, ended_at = ?, spent_tokens = ?, result_json = ?';
  if (options.expectedRevision !== undefined) {
    const result = db
      .prepare(`UPDATE tasks SET ${assignments} WHERE id = ? AND revision = ?`)
      .run(status, startedAt, endedAt, spentTokens, resultJson, id, options.expectedRevision);
    if (Number(result.changes) !== 1) {
      throw new ContractError(
        ERROR_CODES.E_CONFLICT,
        `任务版本冲突: ${id} 期望 revision=${options.expectedRevision}，实际 ${current.revision}`,
      );
    }
  } else {
    const result = db
      .prepare(`UPDATE tasks SET ${assignments} WHERE id = ?`)
      .run(status, startedAt, endedAt, spentTokens, resultJson, id);
    if (Number(result.changes) !== 1) {
      throw new ContractError(ERROR_CODES.E_NOT_FOUND, `任务不存在: ${id}`);
    }
  }

  const updated = getTask(db, id);
  if (!updated) throw new ContractError(ERROR_CODES.E_INTERNAL, `任务更新后读回失败: ${id}`);
  return updated;
}

// ── runs ─────────────────────────────────────────────────────────

export interface NewRunInput {
  taskId: string;
  attempt: number;
  /** 默认 now + 60s（SPEC §4.8 lease_seconds）。 */
  leaseUntil?: number;
  now?: number;
}

export function insertRun(db: DatabaseSync, input: NewRunInput): TaskRun {
  if (!getTask(db, input.taskId)) {
    throw new ContractError(ERROR_CODES.E_NOT_FOUND, `任务不存在: ${input.taskId}`);
  }
  const id = newRunId();
  const now = input.now ?? Date.now();
  const leaseUntil = input.leaseUntil ?? now + 60_000;
  db.prepare(
    `INSERT INTO runs
      (id, task_id, attempt, status, lease_until, steps, error, started_at, ended_at)
     VALUES (?, ?, ?, 'running', ?, 0, NULL, ?, NULL)`,
  ).run(id, input.taskId, input.attempt, leaseUntil, now);
  const run = getRun(db, id);
  if (!run) throw new ContractError(ERROR_CODES.E_INTERNAL, `Run 插入后读回失败: ${id}`);
  return run;
}

export function getRun(db: DatabaseSync, id: string): TaskRun | null {
  const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as unknown as RunRow | undefined;
  return row ? mapRun(row) : null;
}

export function listRuns(db: DatabaseSync, taskId: string): TaskRun[] {
  const rows = db
    .prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY attempt ASC')
    .all(taskId) as unknown as RunRow[];
  return rows.map(mapRun);
}

export function renewRunLease(
  db: DatabaseSync,
  runId: string,
  leaseUntil: number,
  steps?: number,
): TaskRun {
  const run = getRun(db, runId);
  if (!run) throw new ContractError(ERROR_CODES.E_NOT_FOUND, `Run 不存在: ${runId}`);
  if (run.status !== 'running') {
    throw new ContractError(
      ERROR_CODES.E_INVALID_TRANSITION,
      `Run 已结束，不能续约: ${runId} (status=${run.status})`,
    );
  }
  const nextSteps = steps ?? run.steps;
  db.prepare('UPDATE runs SET lease_until = ?, steps = ? WHERE id = ?').run(leaseUntil, nextSteps, runId);
  const updated = getRun(db, runId);
  if (!updated) throw new ContractError(ERROR_CODES.E_INTERNAL, `Run 续约后读回失败: ${runId}`);
  return updated;
}

export interface FinishRunOptions {
  error?: string | null;
  steps?: number;
  now?: number;
}

/** 收尾 run：只允许 running → 终态。 */
export function finishRun(
  db: DatabaseSync,
  runId: string,
  status: RunStatus,
  options: FinishRunOptions = {},
): TaskRun {
  const run = getRun(db, runId);
  if (!run) throw new ContractError(ERROR_CODES.E_NOT_FOUND, `Run 不存在: ${runId}`);
  if (!canRunTransition(run.status, status)) {
    throw new ContractError(
      ERROR_CODES.E_INVALID_TRANSITION,
      `非法 Run 状态转移: ${run.status} -> ${status}`,
    );
  }
  if (!isTerminalRunStatus(status)) {
    throw new ContractError(ERROR_CODES.E_INVALID_ARGUMENT, `finishRun 只接受终态，实际 ${status}`);
  }
  const now = options.now ?? Date.now();
  const error = options.error === undefined ? run.error : options.error;
  const steps = options.steps ?? run.steps;
  db.prepare('UPDATE runs SET status = ?, error = ?, steps = ?, ended_at = ? WHERE id = ?').run(
    status,
    error,
    steps,
    now,
    runId,
  );
  const updated = getRun(db, runId);
  if (!updated) throw new ContractError(ERROR_CODES.E_INTERNAL, `Run 收尾后读回失败: ${runId}`);
  return updated;
}

// ── events ───────────────────────────────────────────────────────

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
