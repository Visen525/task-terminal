/**
 * 任务结构化进度（SPEC §10 M10-04）。
 *
 * 只读推导：状态/尝试次数来自 tasks + runs，过程信息来自 events。
 * 不写表、不写事件、不调用 provider；get_task 与测试共用同一出口。
 */
import type { DatabaseSync } from 'node:sqlite';

import { ContractError, ERROR_CODES } from '../core/errors.ts';
import type { EventType, JsonValue, TaskEvent, TaskStatus } from '../core/types.ts';
import { listEvents, type ListEventsOptions } from '../store/events.ts';
import { getTask, listRuns } from '../store/repo.ts';
import { DEFAULT_LOOP_LIMITS } from './loop.ts';
import { MAX_ARGS_PREVIEW_CHARS } from './executeTool.ts';

/** 与 get_task 的 recent_events 保持同一窗口大小。 */
export const PROGRESS_RECENT_EVENT_LIMIT = 5;
const EVENT_PAGE_SIZE = 500;
const SUMMARY_MAX_CHARS = 160;

export interface TaskProgressCurrentTool {
  tool: string;
  args_preview: string;
}

export interface TaskProgressEvent {
  type: EventType;
  summary: string;
}

export interface TaskProgress {
  status: TaskStatus;
  /** 最新 run 的 attempt；尚无 run 时为 0。 */
  attempt: number;
  /** 该任务事件里最大的 agent.step.step_no；无事件时为 0。 */
  step: number;
  maxSteps: number;
  currentTool: TaskProgressCurrentTool | null;
  elapsedMs: number;
  spentTokens: number;
  budgetTokens: number;
  recentEvents: TaskProgressEvent[];
}

/** 复用主线工具既有的文本截断语义（含省略号）。 */
export function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 1)}…`;
}

function asRecord(value: JsonValue): Record<string, JsonValue> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value;
}

function stringField(record: Record<string, JsonValue> | null, key: string): string | null {
  if (record === null) return null;
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function numberField(record: Record<string, JsonValue> | null, key: string): number {
  if (record === null) return 0;
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/** 最近 5 条事件的「type + 一句摘要」；摘要单行并截断，避免把长输出灌回主线。 */
function summarizeEvent(event: TaskEvent): string {
  const payload = asRecord(event.payload);
  switch (event.type) {
    case 'task.created': {
      const title = stringField(payload, 'title');
      return title === null ? '任务已创建' : `任务创建：${title}`;
    }
    case 'task.queued':
      return '任务进入队列';
    case 'task.started': {
      const attempt = numberField(payload, 'attempt');
      return attempt > 0 ? `开始执行（第 ${attempt} 次尝试）` : '开始执行';
    }
    case 'agent.step': {
      const step = numberField(payload, 'step_no');
      return step > 0 ? `进入第 ${step} 步` : '推进一步';
    }
    case 'llm.call': {
      const input = numberField(payload, 'in');
      const output = numberField(payload, 'out');
      return `模型调用：输入 ${input} / 输出 ${output} tokens`;
    }
    case 'agent.message': {
      const text = stringField(payload, 'text');
      return text === null || text.trim().length === 0 ? '模型输出' : `模型输出：${text}`;
    }
    case 'agent.tool_call': {
      const tool = stringField(payload, 'tool') ?? '未知工具';
      const args = stringField(payload, 'args_preview');
      return args === null || args.length === 0 ? `调用工具 ${tool}` : `调用工具 ${tool}：${args}`;
    }
    case 'agent.tool_result': {
      const ok = payload?.ok === true;
      const preview = stringField(payload, 'preview');
      const code = stringField(payload, 'code');
      const suffix = preview === null || preview.length === 0 ? '' : `：${preview}`;
      if (ok) return `工具返回成功${suffix}`;
      return code === null ? `工具返回失败${suffix}` : `工具返回失败（${code}）${suffix}`;
    }
    case 'artifact.created': {
      const title = stringField(payload, 'title');
      return title === null ? '生成产物' : `生成产物：${title}`;
    }
    case 'summary.generated': {
      const summary = stringField(payload, 'summary');
      return summary === null ? '生成摘要' : `生成摘要：${summary}`;
    }
    case 'budget.warning':
      return 'token 预算预警';
    case 'task.completed':
      return '任务完成';
    case 'task.failed': {
      const reason = stringField(payload, 'reason');
      return reason === null ? '任务失败' : `任务失败：${reason}`;
    }
    case 'task.cancelled': {
      const reason = stringField(payload, 'reason');
      return reason === null ? '任务已取消' : `任务已取消：${reason}`;
    }
    case 'memory.fact_upserted': {
      const key = stringField(payload, 'key');
      return key === null ? '记忆更新' : `记忆更新：${key}`;
    }
    default:
      return event.type;
  }
}

function summarize(event: TaskEvent): string {
  return clip(oneLine(summarizeEvent(event)), SUMMARY_MAX_CHARS);
}

/** listEvents 只有升序分页，逐页取全；进度需要跨全量事件求最大步与 token 累计。 */
function collectTaskEvents(db: DatabaseSync, taskId: string): TaskEvent[] {
  const collected: TaskEvent[] = [];
  let afterSeq: number | undefined;
  for (;;) {
    const options: ListEventsOptions = { taskId, limit: EVENT_PAGE_SIZE };
    if (afterSeq !== undefined) options.afterSeq = afterSeq;
    const batch = listEvents(db, options);
    collected.push(...batch);
    if (batch.length < EVENT_PAGE_SIZE) break;
    const last = batch[batch.length - 1];
    if (last === undefined) break;
    afterSeq = last.seq;
  }
  return collected;
}

/**
 * 正在执行的工具：从前往后扫描，记录最近一条 agent.tool_call；
 * 之后只要出现一条 agent.tool_result（事件按 seq 升序），该调用即视为已收尾。
 * 新调用会把配对状态重置，因此「旧调用的结果」不会误配给「更新的未收尾调用」。
 */
function resolveCurrentTool(events: TaskEvent[]): TaskProgressCurrentTool | null {
  let latestCall: TaskEvent | null = null;
  let settled = false;
  for (const event of events) {
    if (event.type === 'agent.tool_call') {
      latestCall = event;
      settled = false;
    } else if (event.type === 'agent.tool_result' && latestCall !== null) {
      settled = true;
    }
  }
  if (latestCall === null || settled) return null;

  const payload = asRecord(latestCall.payload);
  const tool = stringField(payload, 'tool');
  if (tool === null) return null;
  const argsPreview = stringField(payload, 'args_preview') ?? '';
  return { tool, args_preview: clip(argsPreview, MAX_ARGS_PREVIEW_CHARS) };
}

function resolveElapsedMs(task: { status: TaskStatus; startedAt: number | null; endedAt: number | null }, now: number): number {
  if (task.status === 'running') {
    return task.startedAt === null ? 0 : Math.max(0, now - task.startedAt);
  }
  if (task.startedAt === null || task.endedAt === null) return 0;
  return Math.max(0, task.endedAt - task.startedAt);
}

/**
 * 推导一个任务的结构化进度。
 *
 * 任务不存在时抛 E_NOT_FOUND（与 store/repo 的读取语义一致）；
 * 刚创建、尚无 run / 事件的任务返回 step=0、currentTool=null、elapsedMs=0。
 */
export function buildTaskProgress(
  db: DatabaseSync,
  taskId: string,
  now: number = Date.now(),
): TaskProgress {
  const task = getTask(db, taskId);
  if (task === null) {
    throw new ContractError(ERROR_CODES.E_NOT_FOUND, `任务不存在: ${taskId}`);
  }

  const events = collectTaskEvents(db, taskId);
  let step = 0;
  let spentTokens = 0;
  for (const event of events) {
    const payload = asRecord(event.payload);
    if (event.type === 'agent.step') {
      step = Math.max(step, numberField(payload, 'step_no'));
    } else if (event.type === 'llm.call') {
      spentTokens += numberField(payload, 'in') + numberField(payload, 'out');
    }
  }

  const latestRun = listRuns(db, taskId).at(-1);

  return {
    status: task.status,
    attempt: latestRun?.attempt ?? 0,
    step,
    maxSteps: DEFAULT_LOOP_LIMITS.maxSteps,
    // 只有 running 才可能存在「正在执行」的工具：终态/取消可能因守卫留下未配对的
    // tool_call，waiting_input 的 ask_user 也按设计没有 tool_result，都不能算执行中。
    currentTool: task.status === 'running' ? resolveCurrentTool(events) : null,
    elapsedMs: resolveElapsedMs(task, now),
    spentTokens,
    budgetTokens: task.budgetTokens,
    recentEvents: events.slice(-PROGRESS_RECENT_EVENT_LIMIT).map((event) => ({
      type: event.type,
      summary: summarize(event),
    })),
  };
}
