/**
 * 测试用脚本化 provider（SPEC §5.7 / §7 M3-03）
 *
 * 按脚本顺序消费 chat / stream 调用；每一步只会被消费一次，
 * 因此可以表达“文本 → tool_call → 文本”以及“注入一次错误后恢复”。
 * 不访问网络，不读环境变量。
 */

import { ContractError, ERROR_CODES } from "../core/errors.ts";
import type { LlmResponse, LlmToolCall, TokenUsage } from "../core/types.ts";
import {
  createAbortError,
  estimateTokenUsage,
  throwIfAborted,
  type BalanceInfo,
  type ChatParams,
  type LlmProvider,
  type LlmStreamEvent,
} from "./types.ts";

/** 流式 tool_call 分片；index 对应同一个工具调用。 */
export interface FakeToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  argumentsDelta: string;
}

/** 脚本中的一步。 */
export interface FakeStep {
  content?: string | null;
  toolCalls?: LlmToolCall[];
  finishReason?: string;
  usage?: TokenUsage;
  /** 注入一次错误（该步随后被消费，下一次调用继续走后面的脚本）。 */
  error?: unknown;
  /** 流式文本分片；默认整段一次。传 [] 表示不产文本。 */
  textDeltas?: string[];
  /** 流式思考链分片（M13-02）；先于文本产出，done.response.reasoningContent 汇总。 */
  reasoningDeltas?: string[];
  /** 流式 tool_call 分片；默认每个 tool_call 一次完整参数。 */
  toolCallDeltas?: FakeToolCallDelta[];
  /** 每个事件之间的延迟（毫秒），默认 0。 */
  delayMs?: number;
}

export class FakeProvider implements LlmProvider {
  readonly calls: ChatParams[] = [];

  private readonly script: FakeStep[];
  private cursor = 0;

  constructor(script: FakeStep[]) {
    this.script = [...script];
  }

  /** 剩余未消费的步数。 */
  get pending(): number {
    return this.script.length - this.cursor;
  }

  /** 运行中追加脚本（M3 loop 测试可动态补步骤）。 */
  push(step: FakeStep): void {
    this.script.push(step);
  }

  async chat(params: ChatParams): Promise<LlmResponse> {
    this.calls.push(params);
    const step = this.next("chat");
    if (step.error !== undefined) {
      throw step.error;
    }
    await this.wait(step, params.signal);
    return toResponse(step, params);
  }

  async *stream(params: ChatParams): AsyncGenerator<LlmStreamEvent> {
    this.calls.push(params);
    const step = this.next("stream");
    if (step.error !== undefined) {
      throw step.error;
    }
    await this.wait(step, params.signal);

    const reasoningDeltas = step.reasoningDeltas ?? [];
    for (const text of reasoningDeltas) {
      await this.wait(step, params.signal);
      yield { type: "reasoning_delta", text };
    }

    const textDeltas =
      step.textDeltas ??
      (step.content !== undefined && step.content !== null && step.content.length > 0
        ? [step.content]
        : []);
    for (const text of textDeltas) {
      await this.wait(step, params.signal);
      yield { type: "text_delta", text };
    }

    const toolDeltas =
      step.toolCallDeltas ??
      (step.toolCalls ?? []).map((call, index) => ({
        index,
        id: call.id,
        name: call.function.name,
        argumentsDelta: call.function.arguments,
      }));
    for (const delta of toolDeltas) {
      await this.wait(step, params.signal);
      yield {
        type: "tool_call_delta",
        index: delta.index,
        argumentsDelta: delta.argumentsDelta,
        ...(delta.id !== undefined ? { id: delta.id } : {}),
        ...(delta.name !== undefined ? { name: delta.name } : {}),
      };
    }

    yield { type: "done", response: toResponse(step, params) };
  }

  async checkBalance(signal?: AbortSignal): Promise<BalanceInfo> {
    throwIfAborted(signal);
    return { isAvailable: true, balances: [] };
  }

  private next(operation: string): FakeStep {
    const step = this.script[this.cursor];
    if (step === undefined) {
      throw new ContractError(
        ERROR_CODES.E_INTERNAL,
        `FakeProvider 脚本已耗尽（${operation} 第 ${this.cursor + 1} 步）`,
      );
    }
    this.cursor += 1;
    return step;
  }

  private async wait(step: FakeStep, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (step.delayMs !== undefined && step.delayMs > 0) {
      await delay(step.delayMs, signal);
    }
    throwIfAborted(signal);
  }
}

function toResponse(step: FakeStep, params: ChatParams): LlmResponse {
  const content =
    step.content !== undefined ? step.content : joinTextDeltas(step.textDeltas);
  const toolCalls =
    step.toolCalls !== undefined
      ? step.toolCalls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: {
            name: call.function.name,
            arguments: call.function.arguments,
          },
        }))
      : assembleToolDeltas(step.toolCallDeltas);
  const usage = step.usage ?? estimateTokenUsage(params.messages, content, toolCalls);
  const reasoning = (step.reasoningDeltas ?? []).join("");
  return {
    content,
    toolCalls,
    usage,
    finishReason:
      step.finishReason ?? (toolCalls.length > 0 ? "tool_calls" : "stop"),
    ...(reasoning.length > 0 ? { reasoningContent: reasoning } : {}),
  };
}

function joinTextDeltas(deltas: string[] | undefined): string | null {
  if (deltas === undefined) return null;
  const text = deltas.join("");
  return text.length > 0 ? text : null;
}

function assembleToolDeltas(
  deltas: FakeToolCallDelta[] | undefined,
): LlmToolCall[] {
  if (deltas === undefined) return [];
  const acc = new Map<number, { id: string; name: string; args: string }>();
  for (const delta of deltas) {
    const current = acc.get(delta.index) ?? { id: "", name: "", args: "" };
    current.id += delta.id ?? "";
    current.name += delta.name ?? "";
    current.args += delta.argumentsDelta;
    acc.set(delta.index, current);
  }
  return [...acc.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([index, value]) => ({
      id: value.id.length > 0 ? value.id : `call_${index}`,
      type: "function" as const,
      function: {
        name: value.name,
        arguments: value.args.length > 0 ? value.args : "{}",
      },
    }));
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError(signal.reason));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      cleanup();
      reject(createAbortError(signal?.reason));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
