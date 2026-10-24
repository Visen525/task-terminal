/**
 * DeepSeek 适配器（SPEC §7 M2-01 / 附录 A）
 *
 * 不引 SDK：Node 24 内置 fetch。所有网络 IO 都接受 AbortSignal。
 * 安全约定：apiKey 只从构造函数进来；错误信息统一脱敏，不回显 key / Authorization。
 */

import { ContractError, ERROR_CODES } from "../core/errors.ts";
import type {
  LlmMessage,
  LlmResponse,
  LlmToolCall,
  TokenUsage,
  ToolSpec,
} from "../core/types.ts";
import {
  createAbortError,
  estimateTokenUsage,
  isAbortError,
  throwIfAborted,
  type BalanceEntry,
  type BalanceInfo,
  type ChatParams,
  type LlmProvider,
  type LlmStreamEvent,
} from "./types.ts";

export const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_DEFAULT_MODEL = "deepseek-chat";

export interface DeepSeekTimeouts {
  /** 建立连接 / 等到响应头的预算，默认 10s。 */
  connectMs?: number;
  /** 非流式读取整体响应、流式两帧之间的空闲预算，默认 120s。 */
  readMs?: number;
  /** 流式首个正文 / tool_call 分片的预算（含连接阶段），默认 30s。 */
  firstTokenMs?: number;
}

export interface DeepSeekRetryOptions {
  /** 429 / 500 / 503 的重试次数，默认 3（最多 4 次请求）。 */
  maxRetries?: number;
  /** 指数退避基数：base、2*base、4*base…，默认 500ms。 */
  baseDelayMs?: number;
  /** 指数退避的单次上限，默认 30s；Retry-After 显式值不受此限制。 */
  maxDelayMs?: number;
}

export interface DeepSeekOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeouts?: DeepSeekTimeouts;
  retry?: DeepSeekRetryOptions;
}

type TimeoutKind = "connect" | "read" | "first_token";

const RETRYABLE_STATUSES = new Set([429, 500, 503]);

/** 单次 HTTP 尝试的生命周期：外部 signal + 内部超时 + 可重试请求共用。 */
class RequestScope {
  readonly controller = new AbortController();
  readonly startedAt = Date.now();
  callerAborted = false;
  abortReason: unknown;
  timeoutKind: TimeoutKind | null = null;
  timeoutLabel = "";

  private readonly external: AbortSignal | undefined;
  private readonly onExternalAbort: () => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(external: AbortSignal | undefined) {
    this.external = external;
    this.onExternalAbort = () => {
      this.callerAborted = true;
      this.abortReason = external?.reason;
      this.controller.abort(createAbortError(external?.reason));
    };
    if (external?.aborted) {
      this.callerAborted = true;
      this.abortReason = external.reason;
      this.controller.abort(createAbortError(external.reason));
    } else {
      external?.addEventListener("abort", this.onExternalAbort, { once: true });
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  arm(ms: number, kind: TimeoutKind, label: string): void {
    this.clearTimer();
    this.timeoutKind = null;
    this.timeoutLabel = label;
    this.timer = setTimeout(() => {
      if (this.disposed || this.controller.signal.aborted) return;
      this.timeoutKind = kind;
      this.controller.abort(createAbortError(label));
    }, Math.max(0, ms));
    this.timer.unref?.();
  }

  clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimer();
    this.external?.removeEventListener("abort", this.onExternalAbort);
  }
}

export class DeepSeekProvider implements LlmProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly connectMs: number;
  private readonly readMs: number;
  private readonly firstTokenMs: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(options: DeepSeekOptions) {
    if (options.apiKey.trim().length === 0) {
      throw new ContractError(
        ERROR_CODES.E_PROVIDER_AUTH,
        "DeepSeek API key 不能为空；请通过构造参数注入",
      );
    }
    this.apiKey = options.apiKey.trim();
    this.baseUrl = (options.baseUrl ?? DEEPSEEK_DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.model = options.model ?? DEEPSEEK_DEFAULT_MODEL;
    this.connectMs = options.timeouts?.connectMs ?? 10_000;
    this.readMs = options.timeouts?.readMs ?? 120_000;
    this.firstTokenMs = options.timeouts?.firstTokenMs ?? 30_000;
    this.maxRetries = Math.max(0, options.retry?.maxRetries ?? 3);
    this.baseDelayMs = Math.max(0, options.retry?.baseDelayMs ?? 500);
    this.maxDelayMs = Math.max(0, options.retry?.maxDelayMs ?? 30_000);
  }

  async chat(params: ChatParams): Promise<LlmResponse> {
    const payload = this.buildPayload(params, false);
    const { response, scope } = await this.requestWithRetry(
      "/chat/completions",
      payload,
      params.signal,
      false,
    );
    try {
      const raw = await this.readBodyText(response, scope);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new ContractError(
          ERROR_CODES.E_PROVIDER_HTTP,
          "DeepSeek 非流式响应不是合法 JSON",
        );
      }
      return this.parseChatResponse(parsed, params);
    } finally {
      scope.dispose();
    }
  }

  async *stream(params: ChatParams): AsyncGenerator<LlmStreamEvent> {
    const payload = this.buildPayload(params, true);
    const { response, scope } = await this.requestWithRetry(
      "/chat/completions",
      payload,
      params.signal,
      true,
    );
    const reader = response.body?.getReader();
    if (reader === undefined) {
      scope.dispose();
      throw new ContractError(
        ERROR_CODES.E_PROVIDER_HTTP,
        "DeepSeek 流式响应缺少响应体",
      );
    }

    const decoder = new TextDecoder();
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();
    const firstTokenDeadline = scope.startedAt + this.firstTokenMs;
    let buffer = "";
    let text = "";
    let usageRaw: unknown;
    let finishReason: string | undefined;
    let firstTokenSeen = false;
    let completed = false;

    const processLine = (line: string): { events: LlmStreamEvent[]; done: boolean } => {
      const data = parseSseDataLine(line);
      if (data === null || data.trim().length === 0) {
        return { events: [], done: false };
      }
      if (data.trim() === "[DONE]") {
        return { events: [], done: true };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        throw new ContractError(
          ERROR_CODES.E_PROVIDER_HTTP,
          "DeepSeek 流式帧不是合法 JSON",
        );
      }

      const events: LlmStreamEvent[] = [];
      if (!isRecord(parsed)) {
        return { events, done: false };
      }
      if (isRecord(parsed.error)) {
        const message = asString(parsed.error.message) ?? "流式接口返回错误";
        throw new ContractError(
          ERROR_CODES.E_PROVIDER_HTTP,
          `DeepSeek 流式响应错误：${this.redact(message)}`,
        );
      }
      if (parsed.usage !== undefined) {
        usageRaw = parsed.usage;
      }
      const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
      for (const choice of choices) {
        if (!isRecord(choice)) continue;
        const reason = asString(choice.finish_reason);
        if (reason !== undefined) {
          finishReason = reason;
        }
        if (!isRecord(choice.delta)) continue;
        const delta = choice.delta;

        const content = asString(delta.content);
        if (content !== undefined && content.length > 0) {
          text += content;
          events.push({ type: "text_delta", text: content });
        }

        const rawCalls = delta.tool_calls;
        if (!Array.isArray(rawCalls)) continue;
        rawCalls.forEach((rawCall, position) => {
          if (!isRecord(rawCall)) return;
          const index = asNumber(rawCall.index) ?? position;
          const fn = isRecord(rawCall.function) ? rawCall.function : {};
          const idPart = asString(rawCall.id) ?? "";
          const namePart = asString(fn.name) ?? "";
          const argsPart = asString(fn.arguments) ?? "";

          const acc = toolAcc.get(index) ?? { id: "", name: "", args: "" };
          acc.id += idPart;
          acc.name += namePart;
          acc.args += argsPart;
          toolAcc.set(index, acc);

          if (idPart.length > 0 || namePart.length > 0 || argsPart.length > 0) {
            events.push({
              type: "tool_call_delta",
              index,
              argumentsDelta: argsPart,
              ...(idPart.length > 0 ? { id: idPart } : {}),
              ...(namePart.length > 0 ? { name: namePart } : {}),
            });
          }
        });
      }
      return { events, done: false };
    };

    const emitLine = (line: string): LlmStreamEvent[] => {
      const result = processLine(line);
      if (result.done) {
        completed = true;
      }
      return result.events;
    };

    try {
      while (!completed) {
        throwIfAborted(params.signal);
        const budget = firstTokenSeen
          ? this.readMs
          : Math.max(0, firstTokenDeadline - Date.now());
        if (budget <= 0) {
          throw new ContractError(
            ERROR_CODES.E_PROVIDER_TIMEOUT,
            `DeepSeek 流式首 token 超时（${this.firstTokenMs}ms）`,
          );
        }
        scope.arm(
          budget,
          firstTokenSeen ? "read" : "first_token",
          firstTokenSeen
            ? `读取超时（${this.readMs}ms）`
            : `流式首 token 超时（${this.firstTokenMs}ms）`,
        );

        let readResult: Awaited<ReturnType<typeof reader.read>>;
        try {
          readResult = await reader.read();
        } catch (error) {
          throw this.toRequestError(error, scope);
        } finally {
          scope.clearTimer();
        }

        if (readResult.done) break;
        buffer += decoder.decode(readResult.value, { stream: true });

        let newline = buffer.indexOf("\n");
        while (newline >= 0 && !completed) {
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          for (const event of emitLine(line)) {
            if (event.type === "text_delta" || event.type === "tool_call_delta") {
              firstTokenSeen = true;
            }
            yield event;
          }
          newline = buffer.indexOf("\n");
        }
      }

      if (!completed) {
        buffer += decoder.decode();
        const trailing = buffer.replace(/\r$/, "");
        if (trailing.trim().length > 0) {
          for (const event of emitLine(trailing)) {
            if (event.type === "text_delta" || event.type === "tool_call_delta") {
              firstTokenSeen = true;
            }
            yield event;
          }
        }
      }

      const toolCalls: LlmToolCall[] = [...toolAcc.entries()]
        .sort((left, right) => left[0] - right[0])
        .map(([index, acc]) => ({
          id: acc.id.length > 0 ? acc.id : `call_${index}`,
          type: "function",
          function: {
            name: acc.name,
            arguments: acc.args.length > 0 ? acc.args : "{}",
          },
        }));
      const content = text.length > 0 ? text : null;
      const usage = mapUsage(usageRaw, params.messages, content, toolCalls);
      const response: LlmResponse = {
        content,
        toolCalls,
        usage,
        finishReason:
          finishReason ?? (toolCalls.length > 0 ? "tool_calls" : "stop"),
      };
      yield { type: "done", response };
    } finally {
      scope.dispose();
      try {
        await reader.cancel();
      } catch {
        // 流已结束或已中止时的取消失败不覆盖已交付结果。
      }
    }
  }

  async checkBalance(signal?: AbortSignal): Promise<BalanceInfo> {
    const { response, scope } = await this.requestWithRetry(
      "/user/balance",
      undefined,
      signal,
      false,
    );
    try {
      const raw = await this.readBodyText(response, scope);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new ContractError(
          ERROR_CODES.E_PROVIDER_HTTP,
          "DeepSeek 余额响应不是合法 JSON",
        );
      }
      const info = parseBalance(parsed);
      const hasPositiveBalance = info.balances.some(
        (entry) => Number(entry.totalBalance) > 0,
      );
      if (!info.isAvailable || (info.balances.length > 0 && !hasPositiveBalance)) {
        throw new ContractError(
          ERROR_CODES.E_PROVIDER_QUOTA,
          "DeepSeek 账户余额不足，已暂停调用",
        );
      }
      return info;
    } finally {
      scope.dispose();
    }
  }

  private buildPayload(
    params: ChatParams,
    stream: boolean,
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      model: params.model ?? this.model,
      messages: params.messages.map(toApiMessage),
      stream,
    };
    if (stream) {
      payload.stream_options = { include_usage: true };
    }
    if (params.tools !== undefined && params.tools.length > 0) {
      payload.tools = params.tools.map((tool: ToolSpec) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
      payload.tool_choice = params.toolChoice ?? "auto";
    }
    if (params.temperature !== undefined) {
      payload.temperature = params.temperature;
    }
    if (params.topP !== undefined) {
      payload.top_p = params.topP;
    }
    if (params.maxTokens !== undefined) {
      payload.max_tokens = params.maxTokens;
    }
    // off 由上层映射为“不传 reasoningEffort”；适配器再做一次运行时兜底，
    // 保证显式传入 off（或未来扩展值）也不会发给 API。
    const reasoningEffort: string | undefined = params.reasoningEffort;
    if (reasoningEffort !== undefined && reasoningEffort !== 'off') {
      payload.reasoning_effort = reasoningEffort;
    }
    return payload;
  }

  private parseChatResponse(data: unknown, params: ChatParams): LlmResponse {
    if (!isRecord(data)) {
      throw new ContractError(
        ERROR_CODES.E_PROVIDER_HTTP,
        "DeepSeek 非流式响应结构不合法",
      );
    }
    const choices = Array.isArray(data.choices) ? data.choices : [];
    const choice = choices.find((item): item is Record<string, unknown> =>
      isRecord(item),
    );
    if (choice === undefined) {
      throw new ContractError(
        ERROR_CODES.E_PROVIDER_HTTP,
        "DeepSeek 非流式响应缺少 choices",
      );
    }
    const message = isRecord(choice.message) ? choice.message : {};
    const content = asString(message.content) ?? null;
    const toolCalls = parseToolCalls(message.tool_calls);
    const usage = mapUsage(data.usage, params.messages, content, toolCalls);
    return {
      content,
      toolCalls,
      usage,
      finishReason:
        asString(choice.finish_reason) ??
        (toolCalls.length > 0 ? "tool_calls" : "stop"),
    };
  }

  private async requestWithRetry(
    path: string,
    payload: unknown | undefined,
    signal: AbortSignal | undefined,
    stream: boolean,
  ): Promise<{ response: Response; scope: RequestScope }> {
    throwIfAborted(signal);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: stream ? "text/event-stream" : "application/json",
    };
    if (payload !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    const init: RequestInit = {
      method: payload === undefined ? "GET" : "POST",
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
    };
    const url = `${this.baseUrl}${path}`;

    for (let attempt = 0; ; attempt += 1) {
      throwIfAborted(signal);
      const scope = new RequestScope(signal);
      let response: Response;
      try {
        response = await this.fetchOnce(url, init, scope, stream);
      } catch (error) {
        scope.dispose();
        throw this.toRequestError(error, scope);
      }

      if (response.ok) {
        return { response, scope };
      }

      let httpError: ContractError;
      try {
        httpError = await this.httpErrorFromResponse(response, scope, attempt);
      } catch (error) {
        scope.dispose();
        throw error;
      }
      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      scope.dispose();

      if (!RETRYABLE_STATUSES.has(response.status) || attempt >= this.maxRetries) {
        throw httpError;
      }
      await this.delay(this.retryDelay(attempt, retryAfterMs), signal);
    }
  }

  private async fetchOnce(
    url: string,
    init: RequestInit,
    scope: RequestScope,
    stream: boolean,
  ): Promise<Response> {
    const connectBudget = stream
      ? Math.min(this.connectMs, this.firstTokenMs)
      : this.connectMs;
    const kind: TimeoutKind =
      stream && this.firstTokenMs < this.connectMs ? "first_token" : "connect";
    const label =
      kind === "connect"
        ? `连接超时（${this.connectMs}ms）`
        : `流式首 token 超时（${this.firstTokenMs}ms）`;
    scope.arm(connectBudget, kind, label);
    try {
      return await fetch(url, { ...init, signal: scope.signal });
    } finally {
      scope.clearTimer();
    }
  }

  private async readBodyText(
    response: Response,
    scope: RequestScope,
  ): Promise<string> {
    scope.arm(this.readMs, "read", `读取超时（${this.readMs}ms）`);
    try {
      return await response.text();
    } catch (error) {
      throw this.toRequestError(error, scope);
    } finally {
      scope.clearTimer();
    }
  }

  private async httpErrorFromResponse(
    response: Response,
    scope: RequestScope,
    retries: number,
  ): Promise<ContractError> {
    let detail = "";
    try {
      detail = await this.readBodyText(response, scope);
    } catch (error) {
      if (scope.callerAborted || scope.timeoutKind !== null) {
        throw this.toRequestError(error, scope);
      }
      // 读不到错误体时仍按 HTTP 状态分类，避免掩盖真实状态。
    }

    const apiMessage = extractErrorMessage(detail);
    const suffix =
      apiMessage.length > 0 ? `：${this.redact(apiMessage).slice(0, 300)}` : "";
    const status = response.status;
    switch (status) {
      case 400:
        return new ContractError(
          ERROR_CODES.E_PROVIDER_HTTP,
          `DeepSeek 400：参数错误视为 bug，不重试${suffix}`,
        );
      case 401:
        return new ContractError(
          ERROR_CODES.E_PROVIDER_AUTH,
          `DeepSeek 401 鉴权失败：API key 无效或已过期，请检查 .env 中的 DEEPSEEK_API_KEY${suffix}`,
        );
      case 402:
        return new ContractError(
          ERROR_CODES.E_PROVIDER_QUOTA,
          `DeepSeek 402 余额不足，已暂停调用${suffix}`,
        );
      case 429:
        return new ContractError(
          ERROR_CODES.E_PROVIDER_RATE_LIMIT,
          `DeepSeek 429 限流（已重试 ${retries} 次）${suffix}`,
        );
      case 500:
      case 503:
        return new ContractError(
          ERROR_CODES.E_PROVIDER_HTTP,
          `DeepSeek ${status} 服务异常（已重试 ${retries} 次）${suffix}`,
        );
      default:
        return new ContractError(
          ERROR_CODES.E_PROVIDER_HTTP,
          `DeepSeek HTTP ${status}${suffix}`,
        );
    }
  }

  private toRequestError(error: unknown, scope: RequestScope): Error {
    if (scope.callerAborted) {
      return createAbortError(scope.abortReason);
    }
    if (scope.timeoutKind !== null) {
      return new ContractError(
        ERROR_CODES.E_PROVIDER_TIMEOUT,
        `DeepSeek ${scope.timeoutLabel}`,
      );
    }
    if (isAbortError(error)) {
      return createAbortError();
    }
    return new ContractError(
      ERROR_CODES.E_PROVIDER_HTTP,
      `DeepSeek 请求失败：${this.redact(
        error instanceof Error ? error.message : String(error),
      )}`,
    );
  }

  private retryDelay(attempt: number, retryAfterMs: number | undefined): number {
    const backoff = Math.min(this.baseDelayMs * 2 ** attempt, this.maxDelayMs);
    if (retryAfterMs === undefined) return backoff;
    // 服务端显式给出的 Retry-After 优先，不被指数退避上限截断。
    return Math.max(backoff, retryAfterMs);
  }

  private async delay(ms: number, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (ms <= 0) return;
    await new Promise<void>((resolve, reject) => {
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

  private redact(text: string): string {
    let result = text;
    if (this.apiKey.length > 0) {
      result = result.split(this.apiKey).join("[REDACTED]");
    }
    return result.replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]");
  }
}

// ── 纯解析辅助 ────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * v1.1 多模态：字符串 content 与 LlmContentPart[] 分片都原样透传。
 * DeepSeek 的 /chat/completions 接受 OpenAI 兼容的 image_url 分片；
 * 这里不改写 data URL，也不把数组重新拼成字符串。
 */
function toApiContent(content: LlmMessage['content']): LlmMessage['content'] {
  return content;
}

function toApiMessage(message: LlmMessage): Record<string, unknown> {
  const result: Record<string, unknown> = {
    role: message.role,
    content: toApiContent(message.content),
  };
  if (message.toolCallId !== undefined) {
    result.tool_call_id = message.toolCallId;
  }
  if (message.toolCalls !== undefined) {
    result.tool_calls = message.toolCalls;
  }
  return result;
}

function parseToolCalls(raw: unknown): LlmToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: LlmToolCall[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const fn = isRecord(item.function) ? item.function : {};
    const name = asString(fn.name) ?? "";
    const args = asString(fn.arguments);
    calls.push({
      id: asString(item.id) ?? `call_${calls.length}`,
      type: "function",
      function: {
        name,
        arguments: args !== undefined && args.length > 0 ? args : "{}",
      },
    });
  }
  return calls;
}

function mapUsage(
  raw: unknown,
  messages: LlmMessage[],
  content: string | null,
  toolCalls: LlmToolCall[],
): TokenUsage {
  if (!isRecord(raw)) {
    return estimateTokenUsage(messages, content, toolCalls);
  }
  const input = asNumber(raw.prompt_tokens);
  const output = asNumber(raw.completion_tokens);
  if (input === undefined || output === undefined) {
    const estimate = estimateTokenUsage(messages, content, toolCalls);
    return {
      inputTokens: input ?? estimate.inputTokens,
      cachedTokens: asNumber(raw.prompt_cache_hit_tokens) ?? 0,
      outputTokens: output ?? estimate.outputTokens,
      estimated: true,
    };
  }
  return {
    inputTokens: input,
    cachedTokens: asNumber(raw.prompt_cache_hit_tokens) ?? 0,
    outputTokens: output,
    estimated: false,
  };
}

function parseBalance(data: unknown): BalanceInfo {
  if (!isRecord(data)) {
    throw new ContractError(
      ERROR_CODES.E_PROVIDER_HTTP,
      "DeepSeek 余额响应结构不合法",
    );
  }
  const rawBalances = Array.isArray(data.balance_infos)
    ? data.balance_infos
    : [];
  const balances: BalanceEntry[] = [];
  for (const item of rawBalances) {
    if (!isRecord(item)) continue;
    balances.push({
      currency: asString(item.currency) ?? "",
      totalBalance: balanceString(item.total_balance),
      grantedBalance: balanceString(item.granted_balance),
      toppedUpBalance: balanceString(item.topped_up_balance),
    });
  }
  return {
    isAvailable: data.is_available === true,
    balances,
  };
}

function balanceString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function parseSseDataLine(line: string): string | null {
  if (line.length === 0) return null;
  if (line.startsWith(":")) return null;
  if (!line.startsWith("data:")) return null;
  let value = line.slice(5);
  if (value.startsWith(" ")) value = value.slice(1);
  return value;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.floor(seconds * 1000);
  }
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - Date.now());
  }
  return undefined;
}

function extractErrorMessage(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) return "";
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isRecord(parsed) && isRecord(parsed.error)) {
      const message = asString(parsed.error.message);
      if (message !== undefined) return message;
    }
    if (isRecord(parsed)) {
      const message = asString(parsed.message);
      if (message !== undefined) return message;
    }
  } catch {
    // 非 JSON 错误体，退回原文。
  }
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}
