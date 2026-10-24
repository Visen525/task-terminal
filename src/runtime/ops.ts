/**
 * 任务操作公共层（SPEC §4.3 / §7 M5-01）。
 *
 * 把「状态变更 + 同时写事件」的编排收拢到一处：server 路由与主线工具
 * 都只调用这里的函数，不再各自复制事件顺序。边界：
 *   - 只做 tasks 表、events 表、runs 计数与 scheduler.cancel 的编排；
 *   - 不判断 HTTP 参数、不拼响应、不触发调度 tick（唤醒由调用方负责）；
 *   - 事件顺序与 M4-02 现状完全一致：先 appendEvent，再 updateTaskStatus，
 *     取消最后 abort。
 */
import type { DatabaseSync } from 'node:sqlite';

import { ContractError, ERROR_CODES } from '../core/errors.ts';
import { canTransition } from '../core/state.ts';
import type { PermissionMode, Task } from '../core/types.ts';
import { appendEvent } from '../store/events.ts';
import {
  getTask,
  insertTask,
  listRuns,
  updateTaskStatus,
  type NewTaskInput,
} from '../store/repo.ts';
import { getSettings } from '../store/settings.ts';

/** 任务创建者：用户从 REST 创建，或主线 AI 通过 create_task 派活。 */
export type TaskCreationActor = 'user' | 'main';

/** cancelTask 只需要 scheduler 的 abort 能力，便于测试注入窄接口。 */
export interface TaskCanceller {
  cancel(taskId: string): boolean;
}

export const DEFAULT_CANCEL_REASON = '用户取消';

function notFound(message: string): never {
  throw new ContractError(ERROR_CODES.E_NOT_FOUND, message);
}

function conflict(message: string): never {
  throw new ContractError(ERROR_CODES.E_CONFLICT, message);
}

function requireTask(db: DatabaseSync, taskId: string): Task {
  const task = getTask(db, taskId);
  if (task === null) notFound(`任务不存在: ${taskId}`);
  return task;
}

/**
 * 取消原因在任务/状态检查之后校验，与 M4-02 路由的判定顺序一致：
 * 不存在的任务先 404，非 running 先 409，最后才是 reason 400。
 */
function normalizeCancelReason(raw: unknown): string {
  if (raw === undefined) return DEFAULT_CANCEL_REASON;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new ContractError(ERROR_CODES.E_INVALID_ARGUMENT, 'reason 必须是非空字符串');
  }
  return raw.trim();
}

/**
 * createTask 的权限钳制：read-only < workspace-write，结果取请求与上限的较小者。
 * 未显式给权限时按既有默认 workspace-write 参与钳制（用户 REST 与主线工具同语义）。
 */
function clampPermission(
  db: DatabaseSync,
  requested: PermissionMode | undefined,
): PermissionMode {
  const base: PermissionMode = requested ?? 'workspace-write';
  const cap = getSettings(db).subagentPermissionCap;
  if (cap === 'read-only') return 'read-only';
  return base;
}

/**
 * 创建任务并写入 task.created + task.queued。
 *
 * 事件顺序与 M4-02 的 POST /tasks 相同：created（actor 由调用方决定）→ queued
 * （system）。两条事件与任务行使用同一个时间戳，便于时间线/测试对齐。
 */
export function createTask(
  db: DatabaseSync,
  input: NewTaskInput,
  actor: TaskCreationActor = 'user',
): Task {
  const now = input.now ?? Date.now();
  const task = insertTask(db, {
    ...input,
    permission: clampPermission(db, input.permission),
    now,
  });

  appendEvent(db, {
    taskId: task.id,
    type: 'task.created',
    actor,
    payload: { title: task.title, goal: task.goal, permission: task.permission },
    ts: now,
  });
  appendEvent(db, {
    taskId: task.id,
    type: 'task.queued',
    actor: 'system',
    payload: {},
    ts: now,
  });

  return task;
}

/**
 * 取消任务：仅 running 合法。
 *
 * 与 M4-02 一致：先写 task.cancelled{reason}，再把表置 cancelled，最后
 * scheduler.cancel(taskId) 中止在跑 loop。若该任务不是当前在跑任务，
 * cancel() 返回 false，纯表路径仍已完成。
 */
export function cancelTask(
  db: DatabaseSync,
  scheduler: TaskCanceller | null | undefined,
  taskId: string,
  reason: unknown = DEFAULT_CANCEL_REASON,
  now: number = Date.now(),
): Task {
  const task = requireTask(db, taskId);
  if (!canTransition(task.status, 'cancelled')) {
    conflict(
      `仅 running 任务可取消；当前状态 ${task.status}；合法转移仅 running→cancelled`,
    );
  }
  const resolvedReason = normalizeCancelReason(reason);

  appendEvent(db, {
    taskId: task.id,
    type: 'task.cancelled',
    actor: 'user',
    payload: { reason: resolvedReason },
    ts: now,
  });
  const cancelled = updateTaskStatus(db, task.id, 'cancelled', { now });
  scheduler?.cancel(task.id);
  return cancelled;
}

/**
 * 重试任务：仅 failed 且 runs < 3 合法。
 *
 * 先写 task.queued，再 failed→queued；重试总是新建 run，不复活旧 run。
 * 调度唤醒由调用方（server / 主线工具）负责。
 */
export function retryTask(
  db: DatabaseSync,
  taskId: string,
  now: number = Date.now(),
): Task {
  const task = requireTask(db, taskId);
  if (!canTransition(task.status, 'queued')) {
    conflict(`仅 failed 任务可重试；当前状态 ${task.status}`);
  }

  const attempts = listRuns(db, task.id).length;
  if (attempts >= 3) {
    conflict(`任务已用尽 3 次尝试（attempt=${attempts}），不能再重试`);
  }

  appendEvent(db, {
    taskId: task.id,
    type: 'task.queued',
    actor: 'system',
    payload: {},
    ts: now,
  });
  return updateTaskStatus(db, task.id, 'queued', { now });
}
