/**
 * 看门狗与预算（SPEC §4.8 / §7 M3-04）。
 *
 * 边界：
 * - 单次运行的三重上限仍由 agent/loop.ts 执行；本文件只把任务预算接到
 *   limits.maxTokens，并在 loop 结束后记账，不改 loop/executeTool。
 * - 日预算是“派新任务”的 gate（canStartTask），不打断已在跑的 loop。
 * - 纯日志/告警不改变任务状态；budget.warning 不挂 task_id，避免任务已
 *   completed/failed 后再给该任务追加活动事件导致 foldEvents 非法。
 */
import type { DatabaseSync } from 'node:sqlite';

import {
  DEFAULT_LOOP_LIMITS,
  runLoop,
  type LoopLimits,
  type LoopOutcome,
  type LoopTask,
  type RunLoopOptions,
} from '../agent/loop.ts';
import { appendEvent } from '../store/events.ts';
import { getDailyUsage, insertLlmCall } from '../store/llm-calls.ts';

/** SPEC §4.8：全局日预算 200 万 token。 */
export const DEFAULT_DAILY_BUDGET_TOKENS = 2_000_000;

/** SPEC §4.8：当日用量到 80% 发一次告警。 */
export const DAILY_WARNING_RATIO = 0.8;

/** loop 需要 token 上限，任务行提供 budget_tokens。 */
export interface GuardedLoopTask extends LoopTask {
  budgetTokens: number;
}

export interface RunGuardedLoopOptions extends Omit<RunLoopOptions, 'task' | 'limits'> {
  task: GuardedLoopTask;
  /**
   * 除 maxTokens 外的 loop 上限；maxTokens 一律由 task.budgetTokens 接线，
   * 调用方不能覆盖，避免任务预算被悄悄放宽。
   */
  limits?: Partial<Omit<LoopLimits, 'maxTokens'>>;
  /** 全局日预算；默认 DEFAULT_DAILY_BUDGET_TOKENS。 */
  dailyBudgetTokens?: number;
  /** 可注入时钟（毫秒时间戳）；默认 Date.now。 */
  now?: () => number;
}

export interface LocalDayRange {
  startMs: number;
  endMs: number;
}

/** 本地日历日 [00:00, 次日 00:00)；用 Date 构造器而非固定 24h，兼容夏令时。 */
export function getLocalDayRange(nowMs: number): LocalDayRange {
  const date = new Date(nowMs);
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  return { startMs: start.getTime(), endMs: end.getTime() };
}

export interface DailyBudgetGate {
  allowed: boolean;
  spent: number;
  budget: number;
}

/**
 * 调度器（M4）派新任务前必须调用：当日用量 >= 100% 时返回 allowed:false。
 * 只读判断，不改任何任务状态；已在跑的任务由调用方自行放行。
 */
export function canStartTask(
  db: DatabaseSync,
  now: number,
  dailyBudgetTokens: number = DEFAULT_DAILY_BUDGET_TOKENS,
): DailyBudgetGate {
  const { startMs, endMs } = getLocalDayRange(now);
  const spent = getDailyUsage(db, startMs, endMs);
  return {
    allowed: spent < dailyBudgetTokens,
    spent,
    budget: dailyBudgetTokens,
  };
}

function resolveModel(limits: RunGuardedLoopOptions['limits']): string {
  const model = limits?.model;
  return typeof model === 'string' && model.trim().length > 0
    ? model
    : DEFAULT_LOOP_LIMITS.model;
}

/** 当日是否已发过 budget.warning；用于“恰好一次”去重。 */
function hasDailyBudgetWarning(db: DatabaseSync, startMs: number, endMs: number): boolean {
  const row = db
    .prepare(
      `SELECT seq FROM events
       WHERE type = 'budget.warning' AND ts >= ? AND ts < ?
       ORDER BY seq ASC LIMIT 1`,
    )
    .get(startMs, endMs);
  return row !== undefined;
}

/**
 * 包装 runLoop：
 * 1. task.budgetTokens → limits.maxTokens（既有 max_tokens 终态不变）；
 * 2. 结束后写一条本次运行的汇总 llm_calls（purpose=agent）；
 * 3. 查当日用量，首次跨过 80% 时追加全局 budget.warning（当日去重）。
 *
 * 记账与告警都在 loop 返回后同步完成，中间不 await，单进程内不会重复告警。
 */
export async function runGuardedLoop(options: RunGuardedLoopOptions): Promise<LoopOutcome> {
  const { task, limits, dailyBudgetTokens, now, ...loopOptions } = options;
  const clock = now ?? Date.now;
  const budget = dailyBudgetTokens ?? DEFAULT_DAILY_BUDGET_TOKENS;

  const outcome = await runLoop({
    ...loopOptions,
    task,
    limits: { ...limits, maxTokens: task.budgetTokens },
  });

  const nowMs = clock();
  insertLlmCall(options.db, {
    taskId: task.id,
    runId: options.runId ?? null,
    purpose: 'agent',
    model: resolveModel(limits),
    inputTokens: outcome.usage.inputTokens,
    cachedTokens: outcome.usage.cachedTokens,
    outputTokens: outcome.usage.outputTokens,
    latencyMs: outcome.elapsedMs,
    // loop 的聚合 usage 不暴露 estimated 标记，汇总行按 0 记录。
    estimated: false,
    ts: nowMs,
  });

  const { startMs, endMs } = getLocalDayRange(nowMs);
  const spent = getDailyUsage(options.db, startMs, endMs);
  if (
    spent >= budget * DAILY_WARNING_RATIO &&
    !hasDailyBudgetWarning(options.db, startMs, endMs)
  ) {
    appendEvent(options.db, {
      type: 'budget.warning',
      actor: 'system',
      payload: { spent, budget },
      ts: nowMs,
    });
  }

  return outcome;
}
