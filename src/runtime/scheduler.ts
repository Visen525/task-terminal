/**
 * 任务调度器（SPEC §4.3 / §4.8 / §7 M4-01）。
 *
 * 边界：
 * - 并发恒 1：单进程内一个 busy 标志 + 当前执行 promise，不做锁/线程池；
 *   tick() 在 await 之前同步置 busy，因此并发调用第二个 tick 只会 no-op。
 * - 派任务顺序固定为 insertRun → task.started 事件 → tasks.queued→running；
 *   事件是真相源，表是投影（与 M3-03 “loop 只写事件”衔接）。
 * - loop 自己写 task.completed / task.failed / ask_user 事件并返回 LoopOutcome；
 *   调度器只按 outcome 推进任务表、收 run，不重复写终态事件。
 * - waiting_input：任务表进 waiting_input，本次 run 收 interrupted（一次执行已
 *   结束）；用户回复后的恢复是 waiting_input→running + 新 run，不在本卡。
 * - 租约：默认 60s，每 15s 续约；loop 结束的 finally 里 clearInterval，
 *   回调里发现 run 已结束也会自清，避免定时器泄漏或续约抛错。
 */
import type { DatabaseSync } from 'node:sqlite';

import type { LoopLimits, LoopOutcome, LoopProviderParams, LoopToolContextOptions } from '../agent/loop.ts';
import { persistArtifacts } from '../agent/artifacts.ts';
import type { Task } from '../core/types.ts';
import type { LlmProvider } from '../providers/types.ts';
import { appendEvent } from '../store/events.ts';
import {
  finishRun,
  getTask,
  insertRun,
  listRuns,
  listTasks,
  renewRunLease,
  updateTaskStatus,
} from '../store/repo.ts';
import {
  getSettings,
  type AppSettings,
  type RoleModelSettings,
} from '../store/settings.ts';
import { reapExpiredRuns } from './reaper.ts';
import {
  canStartTask,
  runGuardedLoop,
  type DailyBudgetGate,
  type GuardedLoopTask,
} from './watchdog.ts';

/** SPEC §4.8：租约 60s。 */
export const DEFAULT_LEASE_MS = 60_000;

/** SPEC §4.8：每 15s 续约一次。 */
export const DEFAULT_RENEW_INTERVAL_MS = 15_000;

export interface SchedulerOptions {
  db: DatabaseSync;
  provider: LlmProvider;
  /** 透传 loop 上限；maxTokens 由任务 budgetTokens 接线，不能在此覆盖。 */
  limits?: Partial<Omit<LoopLimits, 'maxTokens'>>;
  /** 透传给工具上下文（outputDir / allowedCommands 等）。 */
  ctx?: LoopToolContextOptions;
  /** 外部取消信号；中止路径按 interrupted 收尾。 */
  signal?: AbortSignal;
  /** 可注入时钟（毫秒时间戳）；默认 Date.now。 */
  now?: () => number;
  /** 租约时长；默认 DEFAULT_LEASE_MS。 */
  leaseMs?: number;
  /** 续约间隔；默认 DEFAULT_RENEW_INTERVAL_MS。 */
  renewIntervalMs?: number;
  /** 显式日预算覆盖；未给时每 tick 取 settings.dailyBudgetTokens。 */
  dailyBudgetTokens?: number;
  /** 创建时先跑一次 reaper（启动恢复）；默认 true。 */
  reapOnStart?: boolean;
}

export type SchedulerTickResult =
  | {
      started: false;
      reason: 'busy' | 'shutdown' | 'empty' | 'budget';
      /** reason === 'budget' 时给出门禁读数。 */
      gate?: DailyBudgetGate;
    }
  | {
      started: true;
      taskId: string;
      runId: string;
      outcome: LoopOutcome;
    };

export interface ShutdownOptions {
  /** true 时立即中止在跑的 loop；run 收 interrupted，任务落 failed。 */
  abort?: boolean;
}

export interface Scheduler {
  /** 取最旧 queued 任务跑一次；忙/停机/无任务/预算拒绝时 no-op 且不写库。 */
  tick(): Promise<SchedulerTickResult>;
  /** 连续 tick 直到没有可启动任务（含启动过的结果）。 */
  runAll(): Promise<SchedulerTickResult[]>;
  /** 停止接新任务，并等待在跑任务结束。 */
  shutdown(options?: ShutdownOptions): Promise<void>;
  /**
   * 中止正在跑的任务；taskId 不是当前任务（或当前没有任务在跑）时返回 false。
   * 表状态/事件由调用方负责，本方法只 abort 内部 controller。
   */
  cancel(taskId: string): boolean;
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

type SchedulerLimits = Partial<Omit<LoopLimits, 'maxTokens'>>;

function providerParamsFor(role: RoleModelSettings): LoopProviderParams {
  return {
    temperature: role.temperature,
    topP: role.topP,
    maxTokens: role.maxTokens,
    ...(role.thinkingLevel === 'off' ? {} : { reasoningEffort: role.thinkingLevel }),
  };
}

/**
 * 每 tick 用当前 subagent 设置组装 limits；显式注入的 limits 仍可覆盖
 * providerParams 中的单项与步数/墙钟（只覆盖出现的字段，不把设置里的其余项丢掉）。
 * maxTokens 不在此组装：任务预算由 watchdog 按 task.budgetTokens 接线（0=不限）。
 */
function buildSubagentLimits(
  settings: AppSettings,
  explicit: SchedulerLimits | undefined,
): SchedulerLimits {
  const fromSettings: SchedulerLimits = {
    model: settings.subagent.model,
    providerParams: providerParamsFor(settings.subagent),
    maxSteps: settings.subagent.maxSteps,
    wallMs: settings.subagent.wallMinutes * 60_000,
  };
  if (explicit === undefined) return fromSettings;
  return {
    ...fromSettings,
    ...explicit,
    providerParams: {
      ...(fromSettings.providerParams ?? {}),
      ...(explicit.providerParams ?? {}),
    },
  };
}

function toGuardedTask(task: Task): GuardedLoopTask {
  return {
    id: task.id,
    title: task.title,
    goal: task.goal,
    permission: task.permission,
    workspace: task.workspace,
    budgetTokens: task.budgetTokens,
  };
}

export function createScheduler(options: SchedulerOptions): Scheduler {
  const { db, provider, limits, ctx, signal: externalSignal } = options;
  const clock = options.now ?? Date.now;
  const leaseMs = positiveOr(options.leaseMs, DEFAULT_LEASE_MS);
  const renewIntervalMs = positiveOr(options.renewIntervalMs, DEFAULT_RENEW_INTERVAL_MS);

  if (options.reapOnStart ?? true) {
    reapExpiredRuns(db, clock());
  }

  let closed = false;
  let busy = false;
  let currentRun: Promise<void> | null = null;
  let currentAbort: AbortController | null = null;
  let currentTaskId: string | null = null;

  async function executeTask(
    task: Task,
    taskLimits: SchedulerLimits,
    dailyBudgetTokens: number,
  ): Promise<{ runId: string; outcome: LoopOutcome }> {
    const attempt = listRuns(db, task.id).length + 1;
    const startedAt = clock();

    // a. 先落 run（occupies 本次执行），b. 再写 started 事件，最后推进任务表。
    const run = insertRun(db, {
      taskId: task.id,
      attempt,
      now: startedAt,
      leaseUntil: startedAt + leaseMs,
    });
    appendEvent(db, {
      taskId: task.id,
      runId: run.id,
      type: 'task.started',
      actor: 'system',
      payload: { run_id: run.id },
      ts: startedAt,
    });
    updateTaskStatus(db, task.id, 'running', {
      now: startedAt,
      expectedRevision: task.revision,
    });

    // 外部 signal 与 shutdown 共用同一个内部 controller。
    const controller = new AbortController();
    currentAbort = controller;
    currentTaskId = task.id;
    const onExternalAbort = (): void => {
      controller.abort(externalSignal?.reason);
    };
    if (externalSignal !== undefined) {
      if (externalSignal.aborted) onExternalAbort();
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    // d. 租约续约；loop 结束即停。
    let leaseTimer: ReturnType<typeof setInterval> | undefined;
    leaseTimer = setInterval(() => {
      try {
        renewRunLease(db, run.id, clock() + leaseMs);
      } catch {
        // run 已被收尾（正常完成 / 外部恢复）：停止续约，不让定时器继续打扰。
        if (leaseTimer !== undefined) clearInterval(leaseTimer);
        leaseTimer = undefined;
      }
    }, renewIntervalMs);
    leaseTimer.unref?.();

    let outcome: LoopOutcome;
    try {
      outcome = await runGuardedLoop({
        db,
        provider,
        task: toGuardedTask(task),
        limits: taskLimits,
        ...(ctx === undefined ? {} : { ctx }),
        signal: controller.signal,
        runId: run.id,
        attempt,
        now: clock,
        dailyBudgetTokens,
        // submit_result 校验通过后、task.completed 事件前落盘产物（M7-01）。
        onBeforeComplete: (result) => {
          persistArtifacts(db, {
            taskId: task.id,
            runId: run.id,
            workspace: task.workspace,
            result,
          });
        },
      });
    } finally {
      if (leaseTimer !== undefined) clearInterval(leaseTimer);
      leaseTimer = undefined;
      currentAbort = null;
      currentTaskId = null;
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }

    // loop 已写好终态事件；这里只推进表 + 收 run。
    const endedAt = clock();

    // M4-02 终态防御：取消路由已把任务写成 cancelled 并 abort，loop 返回的
    // interrupted 不能覆盖任务表；只把本次 run 收 cancelled，不再写任何事件。
    const latest = getTask(db, task.id);
    if (latest?.status === 'cancelled') {
      finishRun(db, run.id, 'cancelled', { now: endedAt, steps: outcome.steps });
      return { runId: run.id, outcome };
    }

    if (outcome.status === 'completed') {
      updateTaskStatus(db, task.id, 'completed', {
        now: endedAt,
        resultJson: outcome.resultJson,
      });
      finishRun(db, run.id, 'completed', { now: endedAt, steps: outcome.steps });
    } else if (outcome.status === 'failed') {
      updateTaskStatus(db, task.id, 'failed', { now: endedAt });
      finishRun(
        db,
        run.id,
        outcome.reason === 'interrupted' ? 'interrupted' : 'failed',
        {
          now: endedAt,
          steps: outcome.steps,
          ...(outcome.error === undefined ? {} : { error: outcome.error.message }),
        },
      );
    } else {
      // waiting_input：ask_user 已让事件流进入 waiting_input；run 视为中断。
      updateTaskStatus(db, task.id, 'waiting_input', { now: endedAt });
      finishRun(db, run.id, 'interrupted', { now: endedAt, steps: outcome.steps });
    }

    return { runId: run.id, outcome };
  }

  async function tick(): Promise<SchedulerTickResult> {
    if (closed) return { started: false, reason: 'shutdown' };
    if (busy) return { started: false, reason: 'busy' };

    const task = listTasks(db, { status: 'queued', limit: 1 })[0];
    if (task === undefined) return { started: false, reason: 'empty' };

    // 每 tick 读一次设置：模型、采样/思考参数、步数/墙钟与日预算都取当前值。
    // options.dailyBudgetTokens 是显式注入的测试/装配覆盖；未给时跟随设置。
    const settings = getSettings(db);
    const dailyBudgetTokens = options.dailyBudgetTokens ?? settings.dailyBudgetTokens;
    const taskLimits = buildSubagentLimits(settings, limits);

    // 日预算 gate 只读；拒绝时本 tick 直接放弃，insertRun/事件/表都不动。
    const gate = canStartTask(db, clock(), dailyBudgetTokens);
    if (!gate.allowed) return { started: false, reason: 'budget', gate };

    // busy 必须在第一次 await 之前置位，保证并发 tick 不会启动第二个任务。
    busy = true;
    const execution = executeTask(task, taskLimits, dailyBudgetTokens);
    currentRun = execution.then(
      () => undefined,
      () => undefined,
    );
    try {
      const { runId, outcome } = await execution;
      return { started: true, taskId: task.id, runId, outcome };
    } finally {
      busy = false;
      currentRun = null;
    }
  }

  async function runAll(): Promise<SchedulerTickResult[]> {
    const results: SchedulerTickResult[] = [];
    for (;;) {
      const result = await tick();
      if (!result.started) return results;
      results.push(result);
    }
  }

  async function shutdown(shutdownOptions: ShutdownOptions = {}): Promise<void> {
    closed = true;
    if (shutdownOptions.abort === true) {
      currentAbort?.abort(new Error('scheduler shutdown'));
    }
    const pending = currentRun;
    if (pending !== null) await pending;
  }

  /** M4-02：只 abort 当前在跑任务的内部 controller，不改表/不写事件。 */
  function cancel(taskId: string): boolean {
    if (currentAbort === null || currentTaskId !== taskId) return false;
    currentAbort.abort(new Error('task cancelled'));
    return true;
  }

  return { tick, runAll, shutdown, cancel };
}
