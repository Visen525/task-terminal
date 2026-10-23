/**
 * 契约层 · 状态机（SPEC §4.3 / §7 M0-02）
 * 硬约束：零依赖、零 IO；纯函数。
 */
import { ContractError, ERROR_CODES } from './errors.ts';
import type { RunStatus, TaskStatus } from './types.ts';

export interface StatusTransition<S extends string> {
  readonly from: S;
  readonly to: S;
}

/** 任务状态转移（SPEC §4.3，终态 completed / cancelled 无出边）。 */
export const TASK_TRANSITIONS: readonly StatusTransition<TaskStatus>[] = [
  { from: 'queued', to: 'running' },
  { from: 'running', to: 'completed' },
  { from: 'running', to: 'failed' },
  { from: 'running', to: 'waiting_input' },
  { from: 'running', to: 'cancelled' },
  { from: 'waiting_input', to: 'running' },
  { from: 'failed', to: 'queued' },
];

/** Run 状态转移：一次执行只能从 running 走向某个终态。 */
export const RUN_TRANSITIONS: readonly StatusTransition<RunStatus>[] = [
  { from: 'running', to: 'completed' },
  { from: 'running', to: 'failed' },
  { from: 'running', to: 'interrupted' },
  { from: 'running', to: 'cancelled' },
];

export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['completed', 'cancelled'];
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  'completed',
  'failed',
  'interrupted',
  'cancelled',
];

export function isTerminalTaskStatus(status: string): boolean {
  return (TERMINAL_TASK_STATUSES as readonly string[]).includes(status);
}

export function isTerminalRunStatus(status: string): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

/** 查询是否允许该任务状态转移；未知状态返回 false，不抛错。 */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS.some((t) => t.from === from && t.to === to);
}

/** 查询是否允许该 run 状态转移；未知状态返回 false，不抛错。 */
export function canRunTransition(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS.some((t) => t.from === from && t.to === to);
}

/** 断言允许转移，否则抛 ContractError(E_INVALID_TRANSITION)。 */
export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new ContractError(
      ERROR_CODES.E_INVALID_TRANSITION,
      `非法任务状态转移: ${from} -> ${to}`,
    );
  }
}

/** 断言允许 run 转移，否则抛 ContractError(E_INVALID_TRANSITION)。 */
export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!canRunTransition(from, to)) {
    throw new ContractError(
      ERROR_CODES.E_INVALID_TRANSITION,
      `非法 Run 状态转移: ${from} -> ${to}`,
    );
  }
}
