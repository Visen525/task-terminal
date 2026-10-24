/**
 * 模型层 · 适配器接口（SPEC §4.1 / 附录 A）
 *
 * 这里只定义 provider 边界与纯工具函数，不含任何网络 IO。
 * `stream()` 的约定：
 *   - 文本与 tool_call 的增量各自以独立事件产出；
 *   - `tool_call_delta` 只是分片，调用方不得在收到 `done` 前解析/执行工具；
 *   - 一次流式调用恰好产出一个 `done`，其中携带组装完成的 `LlmResponse`（含 usage）。
 */

import type {
  LlmMessage,
  LlmResponse,
  LlmToolCall,
  TokenUsage,
  ToolSpec,
} from "../core/types.ts";

/** `tool_choice` 的 OpenAI 兼容形式；DeepSeek 使用 `auto`。 */
export interface ToolChoiceFunction {
  type: "function";
  function: { name: string };
}

export type ToolChoice = "auto" | "none" | ToolChoiceFunction;

/** chat / stream 的公共入参。 */
export interface ChatParams {
  messages: LlmMessage[];
  tools?: ToolSpec[];
  model?: string;
  signal?: AbortSignal;
  /** 默认在提供 tools 时为 `auto`。 */
  toolChoice?: ToolChoice;
}

/** 文本增量。 */
export interface TextDeltaEvent {
  type: "text_delta";
  text: string;
}

/**
 * tool_call 增量。argumentsDelta 是原始 JSON 字符串的一段，
 * 只有最终 `done.response.toolCalls[i].function.arguments` 才是完整参数。
 */
export interface ToolCallDeltaEvent {
  type: "tool_call_delta";
  index: number;
  id?: string;
  name?: string;
  argumentsDelta: string;
}

/** 流式结束事件：恰好出现一次。 */
export interface DoneEvent {
  type: "done";
  response: LlmResponse;
}

export type LlmStreamEvent = TextDeltaEvent | ToolCallDeltaEvent | DoneEvent;

/** 余额条目（DeepSeek `/user/balance` 字段的 camelCase 映射）。 */
export interface BalanceEntry {
  currency: string;
  totalBalance: string;
  grantedBalance: string;
  toppedUpBalance: string;
}

export interface BalanceInfo {
  isAvailable: boolean;
  balances: BalanceEntry[];
}

/** DeepSeek 适配器与测试假 provider 共同实现的接口。 */
export interface LlmProvider {
  chat(params: ChatParams): Promise<LlmResponse>;
  stream(params: ChatParams): AsyncIterable<LlmStreamEvent>;
  /** 部分 provider（如 DeepSeek）支持；假 provider 返回可用余额。 */
  checkBalance?(signal?: AbortSignal): Promise<BalanceInfo>;
}

/** 生成浏览器/Node 语义一致的 AbortError，用于区分“调用方取消”和“超时”。 */
export function createAbortError(reason?: unknown): DOMException {
  const message =
    reason instanceof Error && reason.message.length > 0
      ? reason.message
      : "操作已被调用方中止";
  return new DOMException(message, "AbortError");
}

export function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

/** 所有 IO 入口统一的取消检查。 */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError(signal.reason);
  }
}

/**
 * usage 缺失时的估算（SPEC §4.8：tokens ≈ 字符数 / 2）。
 * 输入取消息正文 + tool_call 参数；输出取正文 + tool_call 参数。
 * 多模态图片按每张 800 token 估算（v1.1），文本分片仍按字符数 / 2。
 */
export function estimateTokenUsage(
  messages: LlmMessage[],
  content: string | null,
  toolCalls: LlmToolCall[],
): TokenUsage {
  let inputChars = 0;
  let imageTokens = 0;
  for (const message of messages) {
    if (typeof message.content === 'string') {
      inputChars += message.content.length;
    } else {
      for (const part of message.content) {
        if (part.type === 'text') inputChars += part.text.length;
        else imageTokens += 800;
      }
    }
    if (message.toolCallId !== undefined) {
      inputChars += message.toolCallId.length;
    }
    for (const call of message.toolCalls ?? []) {
      inputChars +=
        call.id.length + call.function.name.length + call.function.arguments.length;
    }
  }

  let outputChars = content?.length ?? 0;
  for (const call of toolCalls) {
    outputChars += call.function.name.length + call.function.arguments.length;
  }

  return {
    inputTokens: Math.ceil(inputChars / 2) + imageTokens,
    cachedTokens: 0,
    outputTokens: Math.ceil(outputChars / 2),
    estimated: true,
  };
}
