/**
 * DeepSeek 官方联网工具客户端（SPEC §7 M11-01）
 *
 * 只封装两个付费端点：
 *   - POST /v1/tools/search（5 元/千次成功请求，失败/无结果不计费）
 *   - POST /v1/tools/fetch
 *
 * 安全边界：
 *   - apiKey 只从构造参数进入，绝不出现在任何错误消息里；
 *   - url 只接受 http/https、必须含 host、≤8192 字符、禁止 userinfo；
 *   - query 长度 1-128；count 在客户端再钳到 1-20（成本护栏）。
 *
 * 不引 SDK：Node 24 内置 fetch；超时默认 20s，测试可注入更短值。
 */
import { ContractError, ERROR_CODES } from "../core/errors.ts";
import {
  createAbortError,
  isAbortError,
  throwIfAborted,
} from "./types.ts";

export const DEEPSEEK_WEB_DEFAULT_BASE_URL = "https://api.deepseek.com";
export const WEB_TOOL_TIMEOUT_MS = 20_000;
export const WEB_SEARCH_MAX_COUNT = 20;
export const WEB_SEARCH_DEFAULT_COUNT = 10;
export const WEB_SEARCH_MAX_QUERY_CHARS = 128;
export const WEB_FETCH_MAX_URL_CHARS = 8_192;
export const WEB_ERROR_DETAIL_CHARS = 300;

export interface WebSearchItem {
  /** 重排分数；接口缺省时为 null。 */
  rerankScore: number | null;
  title: string;
  url: string;
  snippet: string;
  /** 为模型阅读设计的 600-800 字摘要；优先于 content 阅读。 */
  summary: string;
  /** need_content=false 时接口恒为空串。 */
  content: string;
  siteName: string;
  date: string;
  authority: string;
}

export interface WebSearchResponse {
  results: WebSearchItem[];
}

export interface WebFetchResponse {
  title: string;
  content: string;
}

export interface WebSearchParams {
  query: string;
  /** 1-50 为接口范围；本客户端钳到 1-20。 */
  count?: number;
  needContent?: boolean;
  signal?: AbortSignal;
}

export interface WebFetchParams {
  url: string;
  signal?: AbortSignal;
}

export interface WebToolsClient {
  search(params: WebSearchParams): Promise<WebSearchResponse>;
  fetchPage(params: WebFetchParams): Promise<WebFetchResponse>;
}

export interface CreateWebToolsClientOptions {
  apiKey: string;
  /** 测试可注入 mock server 的 127.0.0.1 随机端口。 */
  baseUrl?: string;
  /** 测试可注入 fetch 实现。 */
  fetchImpl?: typeof fetch;
  /** 单次请求总超时，默认 WEB_TOOL_TIMEOUT_MS（20s）。 */
  timeoutMs?: number;
}

function invalid(message: string): ContractError {
  return new ContractError(ERROR_CODES.E_INVALID_ARGUMENT, message);
}

/** query 必填，trim 后 1-128 字符。 */
export function normalizeSearchQuery(raw: unknown): string {
  if (typeof raw !== "string") throw invalid("query must be a string");
  const query = raw.trim();
  if (query.length < 1 || query.length > WEB_SEARCH_MAX_QUERY_CHARS) {
    throw invalid(`query must be 1-${String(WEB_SEARCH_MAX_QUERY_CHARS)} characters`);
  }
  return query;
}

/** count 缺省 10；非法类型报参数错误，数值向下取整后钳到 1-20。 */
export function normalizeSearchCount(raw: unknown): number {
  if (raw === undefined) return WEB_SEARCH_DEFAULT_COUNT;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw invalid("count must be a finite number");
  }
  const count = Math.floor(raw);
  return Math.min(WEB_SEARCH_MAX_COUNT, Math.max(1, count));
}

export function normalizeNeedContent(raw: unknown): boolean {
  if (raw === undefined) return false;
  if (typeof raw !== "boolean") throw invalid("need_content must be a boolean");
  return raw;
}

/** url 只接受 http/https、含 host、≤8192 字符、禁止 userinfo。 */
export function normalizeFetchUrl(raw: unknown): string {
  if (typeof raw !== "string") throw invalid("url must be a string");
  const url = raw.trim();
  if (url.length < 1 || url.length > WEB_FETCH_MAX_URL_CHARS) {
    throw invalid(`url must be 1-${String(WEB_FETCH_MAX_URL_CHARS)} characters`);
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw invalid("url is not a valid absolute URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw invalid("url must use http or https");
  }
  if (parsed.host.length === 0) throw invalid("url must contain a host");
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw invalid("url must not contain userinfo");
  }
  return url;
}

function normalizeTimeout(raw: number | undefined): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : WEB_TOOL_TIMEOUT_MS;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function asScore(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseSearchResponse(data: unknown): WebSearchResponse {
  if (!isRecord(data) || !Array.isArray(data.results)) {
    throw new ContractError(
      ERROR_CODES.E_PROVIDER_HTTP,
      "联网搜索响应结构不合法：缺少 results 数组",
    );
  }
  const results: WebSearchItem[] = [];
  for (const raw of data.results) {
    if (!isRecord(raw)) continue;
    results.push({
      rerankScore: asScore(raw.rerank_score),
      title: asText(raw.title),
      url: asText(raw.url),
      snippet: asText(raw.snippet),
      summary: asText(raw.summary),
      content: asText(raw.content),
      siteName: asText(raw.site_name),
      date: asText(raw.date),
      authority: asText(raw.authority),
    });
  }
  return { results };
}

function parseFetchResponse(data: unknown): WebFetchResponse {
  if (!isRecord(data)) {
    throw new ContractError(ERROR_CODES.E_PROVIDER_HTTP, "网页读取响应结构不合法");
  }
  const content = data.content;
  if (typeof content !== "string") {
    throw new ContractError(ERROR_CODES.E_PROVIDER_HTTP, "网页读取响应缺少 content");
  }
  return { title: asText(data.title), content };
}

function extractErrorMessage(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) return "";
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isRecord(parsed) && isRecord(parsed.error)) {
      const message = asText(parsed.error.message);
      if (message.length > 0) return message;
    }
    if (isRecord(parsed)) {
      const message = asText(parsed.message);
      if (message.length > 0) return message;
    }
  } catch {
    // 非 JSON 错误体，退回原文。
  }
  return trimmed.length > WEB_ERROR_DETAIL_CHARS
    ? `${trimmed.slice(0, WEB_ERROR_DETAIL_CHARS)}…`
    : trimmed;
}

interface RequestScope {
  signal: AbortSignal;
  callerAborted: boolean;
  abortReason: unknown;
  timedOut: boolean;
  dispose(): void;
}

function createRequestScope(
  external: AbortSignal | undefined,
  timeoutMs: number,
): RequestScope {
  const controller = new AbortController();
  let callerAborted = false;
  let abortReason: unknown;
  let timedOut = false;
  let disposed = false;

  const onExternalAbort = (): void => {
    callerAborted = true;
    abortReason = external?.reason;
    controller.abort(createAbortError(external?.reason));
  };

  if (external?.aborted === true) {
    callerAborted = true;
    abortReason = external.reason;
    controller.abort(createAbortError(external.reason));
  } else {
    external?.addEventListener("abort", onExternalAbort, { once: true });
  }

  const timer = setTimeout(() => {
    if (disposed || controller.signal.aborted) return;
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref?.();

  return {
    signal: controller.signal,
    get callerAborted() {
      return callerAborted;
    },
    get abortReason() {
      return abortReason;
    },
    get timedOut() {
      return timedOut;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      external?.removeEventListener("abort", onExternalAbort);
    },
  };
}

export function createWebToolsClient(options: CreateWebToolsClientOptions): WebToolsClient {
  if (typeof options.apiKey !== "string" || options.apiKey.trim().length === 0) {
    throw new ContractError(ERROR_CODES.E_PROVIDER_AUTH, "联网工具 API key 不能为空");
  }
  const apiKey = options.apiKey.trim();
  const baseUrl = (options.baseUrl ?? DEEPSEEK_WEB_DEFAULT_BASE_URL).replace(/\/+$/u, "");
  const fetchImpl: typeof fetch = options.fetchImpl ?? fetch;
  const timeoutMs = normalizeTimeout(options.timeoutMs);

  function redact(text: string): string {
    let result = text;
    if (apiKey.length > 0) result = result.split(apiKey).join("[REDACTED]");
    return result.replace(/Bearer\s+[^\s"']+/giu, "Bearer [REDACTED]");
  }

  function transportError(error: unknown, scope: RequestScope): Error {
    if (scope.callerAborted) return createAbortError(scope.abortReason);
    if (scope.timedOut) {
      return new ContractError(
        ERROR_CODES.E_PROVIDER_TIMEOUT,
        `联网工具请求超时（${String(timeoutMs)}ms）`,
      );
    }
    if (isAbortError(error)) return createAbortError();
    return new ContractError(
      ERROR_CODES.E_PROVIDER_HTTP,
      `联网工具请求失败：${redact(error instanceof Error ? error.message : String(error))}`,
    );
  }

  function httpError(status: number, body: string): ContractError {
    const raw = redact(extractErrorMessage(body));
    const detail =
      raw.length > WEB_ERROR_DETAIL_CHARS
        ? `${raw.slice(0, WEB_ERROR_DETAIL_CHARS)}…`
        : raw;
    const suffix = detail.length > 0 ? `：${detail}` : "";
    switch (status) {
      case 401:
        return new ContractError(
          ERROR_CODES.E_PROVIDER_AUTH,
          `联网工具 401 鉴权失败：API key 无效或已过期${suffix}`,
        );
      case 429:
        return new ContractError(
          ERROR_CODES.E_PROVIDER_RATE_LIMIT,
          `联网工具 429 限流：请降低检索频率${suffix}`,
        );
      default:
        return new ContractError(ERROR_CODES.E_PROVIDER_HTTP, `联网工具 HTTP ${status}${suffix}`);
    }
  }

  async function postJson(
    path: string,
    payload: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    throwIfAborted(signal);
    const scope = createRequestScope(signal, timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}${path}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: scope.signal,
        });
      } catch (error) {
        throw transportError(error, scope);
      }

      let body: string;
      try {
        body = await response.text();
      } catch (error) {
        throw transportError(error, scope);
      }

      if (!response.ok) throw httpError(response.status, body);

      try {
        return JSON.parse(body) as unknown;
      } catch {
        throw new ContractError(ERROR_CODES.E_PROVIDER_HTTP, "联网工具响应不是合法 JSON");
      }
    } finally {
      scope.dispose();
    }
  }

  return {
    async search(params: WebSearchParams): Promise<WebSearchResponse> {
      const query = normalizeSearchQuery(params.query);
      const count = normalizeSearchCount(params.count);
      const needContent = normalizeNeedContent(params.needContent);
      const data = await postJson(
        "/v1/tools/search",
        { query, count, need_content: needContent },
        params.signal,
      );
      return parseSearchResponse(data);
    },

    async fetchPage(params: WebFetchParams): Promise<WebFetchResponse> {
      const url = normalizeFetchUrl(params.url);
      const data = await postJson("/v1/tools/fetch", { url }, params.signal);
      return parseFetchResponse(data);
    },
  };
}
