/**
 * 契约层 · 事件折叠（SPEC §4.3 / §4.4 / §7 M1-01）
 * 硬约束：零依赖、零 IO；纯函数。
 *
 * 折叠约定：
 * - `task.created` 必须最先出现，任务初始状态为 queued；
 * - `task.queued` 在 queued 下是幂等标记（兼容 created → queued），
 *   failed → queued 表示重试并递增 attempt；
 * - `task.started` 承接 queued → running 与 waiting_input → running（回复后恢复）；
 * - `agent.tool_call` 的 tool 为 `ask_user` 时进入 waiting_input；
 * - 其余活动事件只允许在 running 阶段出现；`memory.fact_upserted` 不参与任务状态。
 */
import { ContractError, ERROR_CODES } from './errors.ts';
import { assertTransition } from './state.ts';
import type { EventType, JsonValue, TaskEvent, TaskStatus } from './types.ts';

/** 事件流折叠出的任务当前视图；只含事件可推导字段。 */
export interface FoldedTaskState {
  taskId: string | null;
  status: TaskStatus;
  title: string | null;
  goal: string | null;
  createdAt: number | null;
  startedAt: number | null;
  endedAt: number | null;
  /** 已观察到的 agent.step 次数（跨重试累计）。 */
  steps: number;
  /** 第几次执行；首次为 1，failed → queued 时递增。 */
  attempt: number;
  runId: string | null;
  /** 最后一条 agent.message 的文本摘要。 */
  lastMessage: string | null;
  /** 最近一次 ask_user 的问题；恢复运行后清空。 */
  pendingQuestion: string | null;
  resultJson: string | null;
  error: string | null;
  lastEventSeq: number;
  lastEventType: EventType;
}

interface PayloadRecord {
  [key: string]: JsonValue;
}

function payloadRecord(payload: JsonValue): PayloadRecord | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  return payload as PayloadRecord;
}

function stringField(payload: JsonValue, key: string): string | null {
  const value = payloadRecord(payload)?.[key];
  return typeof value === 'string' ? value : null;
}

function jsonText(value: JsonValue | undefined): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? null);
}

function invalidTransition(message: string): ContractError {
  return new ContractError(ERROR_CODES.E_INVALID_TRANSITION, message);
}

function enter(state: FoldedTaskState, next: TaskStatus): void {
  assertTransition(state.status, next);
  state.status = next;
}

function requireRunning(state: FoldedTaskState, event: TaskEvent): void {
  if (state.status !== 'running') {
    throw invalidTransition(`事件 ${event.type}(seq=${event.seq}) 不允许出现在 ${state.status}`);
  }
}

function initialState(event: TaskEvent): FoldedTaskState {
  return {
    taskId: event.taskId,
    status: 'queued',
    title: stringField(event.payload, 'title'),
    goal: stringField(event.payload, 'goal'),
    createdAt: event.ts,
    startedAt: null,
    endedAt: null,
    steps: 0,
    attempt: 1,
    runId: stringField(event.payload, 'run_id'),
    lastMessage: null,
    pendingQuestion: null,
    resultJson: null,
    error: null,
    lastEventSeq: event.seq,
    lastEventType: event.type,
  };
}

/**
 * 把同一任务的事件数组折叠为当前状态。
 * 输入按 seq 升序处理（不修改入参）；空流、缺少 task.created、
 * 或任何与 state.ts 转移表冲突的序列抛 ContractError(E_INVALID_TRANSITION)。
 */
export function foldEvents(events: readonly TaskEvent[]): FoldedTaskState {
  if (events.length === 0) {
    throw invalidTransition('事件流为空，缺少 task.created');
  }

  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  let state: FoldedTaskState | null = null;

  for (const event of sorted) {
    if (event.type === 'task.created') {
      if (state !== null) {
        throw invalidTransition(`重复的 task.created(seq=${event.seq})`);
      }
      state = initialState(event);
      continue;
    }

    if (state === null) {
      throw invalidTransition(`事件流缺少 task.created，首条事件为 ${event.type}`);
    }

    switch (event.type) {
      case 'task.queued': {
        if (state.status !== 'queued') {
          enter(state, 'queued');
          state.attempt += 1;
        }
        state.endedAt = null;
        state.runId = stringField(event.payload, 'run_id') ?? state.runId;
        break;
      }

      case 'task.started': {
        enter(state, 'running');
        state.startedAt ??= event.ts;
        state.endedAt = null;
        state.pendingQuestion = null;
        state.error = null;
        state.runId = stringField(event.payload, 'run_id') ?? state.runId;
        break;
      }

      case 'task.completed': {
        enter(state, 'completed');
        state.endedAt = event.ts;
        state.pendingQuestion = null;
        state.error = null;
        state.resultJson = jsonText(payloadRecord(event.payload)?.['result_json']);
        break;
      }

      case 'task.failed': {
        enter(state, 'failed');
        state.endedAt = event.ts;
        state.pendingQuestion = null;
        state.error = stringField(event.payload, 'reason') ?? 'unknown';
        break;
      }

      case 'task.cancelled': {
        enter(state, 'cancelled');
        state.endedAt = event.ts;
        state.pendingQuestion = null;
        state.error = stringField(event.payload, 'reason') ?? 'cancelled';
        break;
      }

      case 'agent.step': {
        requireRunning(state, event);
        state.steps += 1;
        break;
      }

      case 'agent.message': {
        requireRunning(state, event);
        state.lastMessage = stringField(event.payload, 'text');
        break;
      }

      case 'agent.tool_call': {
        requireRunning(state, event);
        if (stringField(event.payload, 'tool') === 'ask_user') {
          enter(state, 'waiting_input');
          state.pendingQuestion =
            stringField(event.payload, 'question') ?? stringField(event.payload, 'args_preview');
        }
        break;
      }

      case 'agent.tool_result':
      case 'llm.call':
      case 'artifact.created':
      case 'summary.generated':
      case 'budget.warning': {
        requireRunning(state, event);
        break;
      }

      case 'memory.fact_upserted': {
        // 长期记忆是跨任务事实，不改变任务状态。
        break;
      }

      default: {
        // EVENT_TYPES 已穷尽；运行期遇到未知 type 时拒绝，避免静默吞掉脏数据。
        const unknown: never = event.type;
        throw invalidTransition(`未知事件类型: ${String(unknown)}`);
      }
    }

    state.lastEventSeq = event.seq;
    state.lastEventType = event.type;
  }

  if (state === null) {
    throw invalidTransition('事件流为空，缺少 task.created');
  }
  return state;
}
