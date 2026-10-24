/**
 * LLM 调用记账（SPEC §4.2 / §4.8 / §7 M3-04）。
 *
 * 只负责 llm_calls 表的写入与按日聚合，不解释预算业务；
 * 80% 告警 / 100% 停派由 runtime/watchdog 决定。
 *
 * ID 选择：`l_<ulid>`，与 tasks 的 `t_`、runs 的 `r_` 保持同一族前缀。
 */
import type { DatabaseSync } from 'node:sqlite';

import { newUlid } from './ulid.ts';

/** SPEC §4.2：main | agent | title。 */
export type LlmCallPurpose = 'main' | 'agent' | 'title';

export interface NewLlmCallInput {
  taskId?: string | null;
  runId?: string | null;
  purpose: LlmCallPurpose;
  model: string;
  inputTokens: number;
  cachedTokens?: number;
  outputTokens: number;
  latencyMs?: number | null;
  /** usage 缺失时按字符数估算 → true；落库为 0/1。 */
  estimated?: boolean;
  /** 调用时间戳（毫秒）；默认 Date.now()。 */
  ts?: number;
}

export interface LlmCall {
  id: string;
  taskId: string | null;
  runId: string | null;
  purpose: LlmCallPurpose;
  model: string;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  latencyMs: number | null;
  estimated: boolean;
  ts: number;
}

/** 与 t_/r_ 一致：加一层可读前缀，ULID 主体仍保证时间有序。 */
export function newLlmCallId(now?: number): string {
  return `l_${newUlid(now)}`;
}

/** 写入一条 LLM 调用记录，返回落库后的内存视图。 */
export function insertLlmCall(db: DatabaseSync, input: NewLlmCallInput): LlmCall {
  const ts = input.ts ?? Date.now();
  const id = newLlmCallId(ts);
  const cachedTokens = input.cachedTokens ?? 0;
  const latencyMs = input.latencyMs ?? null;
  const estimated = input.estimated === true;

  db.prepare(
    `INSERT INTO llm_calls
      (id, task_id, run_id, purpose, model, input_tokens, cached_tokens,
       output_tokens, latency_ms, estimated, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.taskId ?? null,
    input.runId ?? null,
    input.purpose,
    input.model,
    input.inputTokens,
    cachedTokens,
    input.outputTokens,
    latencyMs,
    estimated ? 1 : 0,
    ts,
  );

  return {
    id,
    taskId: input.taskId ?? null,
    runId: input.runId ?? null,
    purpose: input.purpose,
    model: input.model,
    inputTokens: input.inputTokens,
    cachedTokens,
    outputTokens: input.outputTokens,
    latencyMs,
    estimated,
    ts,
  };
}

/**
 * 区间 [dayStartMs, dayEndMs) 内的 input + output 总量。
 * cached 是 input 的子集，不重复计入。一次 SUM 查询完成。
 */
export function getDailyUsage(db: DatabaseSync, dayStartMs: number, dayEndMs: number): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS total
       FROM llm_calls
       WHERE ts >= ? AND ts < ?`,
    )
    .get(dayStartMs, dayEndMs) as unknown as { total: number | bigint } | undefined;
  return Number(row?.total ?? 0);
}
