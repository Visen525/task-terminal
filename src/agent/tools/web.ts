/**
 * 子智能体 · DeepSeek 官方联网工具（SPEC §7 M11-01）
 *
 * 两个工具都走 `executeTool` 注册表：
 *   - web_search：query / count?=8 / need_content?=false
 *   - web_fetch ：url
 *
 * 成本护栏：每个 run（每个 ToolContext）最多 30 次联网调用，search 与
 * fetch 共用一个计数；第 31 次直接返回结构化 E_BUDGET_EXCEEDED，不发网络。
 * 计数放在本模块的 WeakMap 里：loop 每个 run 都会 createToolContext，
 * 因此 ctx 天然就是 run 级作用域，executeTool 不必新增计数字段。
 *
 * apiKey 只从 ctx.webTools 读取（由装配层注入），任何错误消息都不回显。
 */
import { ContractError, ERROR_CODES, type ErrorCode } from "../../core/errors.ts";
import type { ToolSpec } from "../../core/types.ts";
import {
  createWebToolsClient,
  normalizeFetchUrl,
  normalizeNeedContent,
  normalizeSearchCount,
  normalizeSearchQuery,
  type WebSearchResponse,
  type WebToolsClient,
  type WebFetchResponse,
} from "../../providers/web-tools.ts";
import { isAbortError } from "../../providers/types.ts";
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  registerTool,
  type ToolContext,
  type ToolExecution,
} from "../executeTool.ts";

export const MAX_WEB_CALLS_PER_RUN = 30;
export const WEB_SEARCH_DEFAULT_TOOL_COUNT = 8;
/** need_content=true 时每条正文的上限，避免单条结果吃掉整个上下文。 */
export const WEB_CONTENT_LIMIT_BYTES = 20 * 1024;

// ── 工具声明 ─────────────────────────────────────────────────────

export const WEB_SEARCH_SPEC: ToolSpec = {
  name: "web_search",
  description:
    "联网检索公开网页；返回 title / url / date / authority / rerank_score / summary。默认 count=8（最多 20）；需要正文时传 need_content=true（每条正文最多 20KB）。优先阅读 summary。",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        minLength: 1,
        maxLength: 128,
        description: "检索词，1-128 字符",
      },
      count: {
        type: "integer",
        minimum: 1,
        maximum: 20,
        default: WEB_SEARCH_DEFAULT_TOOL_COUNT,
        description: "返回条数，默认 8，最多 20",
      },
      need_content: {
        type: "boolean",
        default: false,
        description: "是否需要正文；默认 false 只取 summary",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

export const WEB_FETCH_SPEC: ToolSpec = {
  name: "web_fetch",
  description:
    "读取一个 http/https 网页的标题与正文；url 禁止 userinfo，最长 8192 字符，正文受工具输出上限约束。",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        minLength: 1,
        maxLength: 8192,
        description: "要读取的 http/https URL",
      },
    },
    required: ["url"],
    additionalProperties: false,
  },
};

export const WEB_TOOL_SPECS: ToolSpec[] = [WEB_SEARCH_SPEC, WEB_FETCH_SPEC];

/**
 * 装配层用：把联网工具声明并入子智能体工具表。
 *
 * 为什么不直接改 executeTool 的 TOOL_SPECS：M3 的既有断言要求该数组
 * 恰好是六件套；工具声明在启动装配时追加，既有防线与测试零改动。
 */
export function installWebToolSpecs(target: ToolSpec[]): void {
  for (const spec of WEB_TOOL_SPECS) {
    if (!target.some((existing) => existing.name === spec.name)) target.push(spec);
  }
}

// ── 每 run 计数与客户端缓存 ──────────────────────────────────────

const webCallCounts = new WeakMap<ToolContext, number>();
const webClients = new WeakMap<ToolContext, WebToolsClient>();

/** 只用于测试/观测；返回该 ctx 已发起的联网调用次数。 */
export function getWebCallCount(ctx: ToolContext): number {
  return webCallCounts.get(ctx) ?? 0;
}

interface CallBudget {
  allowed: boolean;
  used: number;
}

/**
 * 计数在参数与配置校验之后、真正发网络之前递增：参数错误不扣次数，
 * 但已经发起的调用（包括 429/500）会消耗次数，防止模型用失败调用刷额度。
 */
function consumeWebCall(ctx: ToolContext): CallBudget {
  const used = webCallCounts.get(ctx) ?? 0;
  if (used >= MAX_WEB_CALLS_PER_RUN) return { allowed: false, used };
  const next = used + 1;
  webCallCounts.set(ctx, next);
  return { allowed: true, used: next };
}

function clientFor(ctx: ToolContext): WebToolsClient {
  const cached = webClients.get(ctx);
  if (cached !== undefined) return cached;

  const options = ctx.webTools;
  if (
    options === undefined ||
    typeof options.apiKey !== "string" ||
    options.apiKey.trim().length === 0
  ) {
    throw new ContractError(
      ERROR_CODES.E_PROVIDER_AUTH,
      "联网工具未配置 API key；请由装配层注入 ctx.webTools.apiKey",
    );
  }

  const client = createWebToolsClient({
    apiKey: options.apiKey,
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
  });
  webClients.set(ctx, client);
  return client;
}

// ── 结果整形 ─────────────────────────────────────────────────────

function failure(code: ErrorCode, message: string): ToolExecution {
  return { ok: false, code, output: message, preview: message };
}

/** 预期错误转结构化失败；调用方 abort 必须继续向上抛，交给 loop 收尾。 */
function toFailure(error: unknown): ToolExecution | null {
  if (error instanceof ContractError) {
    return failure(error.code, error.message.length > 0 ? error.message : error.code);
  }
  if (isAbortError(error)) return null;
  return failure(ERROR_CODES.E_INTERNAL, "联网工具执行失败");
}

interface TruncatedText {
  output: string;
  truncated: boolean;
  originalBytes: number;
}

function truncateUtf8(text: string, maxBytes: number, markerText: string): TruncatedText {
  const originalBytes = Buffer.byteLength(text, "utf8");
  if (originalBytes <= maxBytes) return { output: text, truncated: false, originalBytes };

  const marker = `\n…[${markerText}: ${String(originalBytes)} bytes total]…\n`;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (maxBytes <= markerBytes + 2) {
    return { output: marker, truncated: true, originalBytes };
  }

  const remaining = maxBytes - markerBytes;
  const headBytes = Math.floor(remaining / 2);
  const tailBytes = remaining - headBytes;
  const buffer = Buffer.from(text, "utf8");
  const head = buffer.subarray(0, headBytes).toString("utf8");
  const tail = buffer.subarray(buffer.length - tailBytes).toString("utf8");
  return { output: head + marker + tail, truncated: true, originalBytes };
}

function maxOutputBytes(ctx: ToolContext): number {
  const configured = ctx.maxOutputBytes;
  return typeof configured === "number" && Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_MAX_OUTPUT_BYTES;
}

function clipContent(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "（接口未返回正文）";
  return truncateUtf8(trimmed, WEB_CONTENT_LIMIT_BYTES, "内容已截断 / content truncated").output;
}

function formatSearchResult(
  response: WebSearchResponse,
  query: string,
  needContent: boolean,
): string {
  const count = response.results.length;
  const lines: string[] = [`搜索结果（query: ${query}，共 ${String(count)} 条）`];
  if (count === 0) {
    lines.push("（无结果；接口对无结果请求不计费，可换个检索词重试）");
    return lines.join("\n");
  }

  response.results.forEach((item, index) => {
    lines.push("");
    lines.push(`[${String(index + 1)}] ${item.title.length > 0 ? item.title : "（无标题）"}`);
    lines.push(`URL: ${item.url.length > 0 ? item.url : "（无 URL）"}`);
    lines.push(`Date: ${item.date.length > 0 ? item.date : "—"}`);
    lines.push(`Authority: ${item.authority.length > 0 ? item.authority : "—"}`);
    lines.push(
      `Rerank: ${item.rerankScore === null ? "—" : String(item.rerankScore)}`,
    );
    const summary = item.summary.length > 0 ? item.summary : item.snippet;
    lines.push(`Summary: ${summary.length > 0 ? summary : "（无摘要）"}`);
    if (needContent) lines.push(`Content:\n${clipContent(item.content)}`);
  });
  return lines.join("\n");
}

function formatFetchResult(response: WebFetchResponse): string {
  const title = response.title.trim().length > 0 ? response.title.trim() : "（无标题）";
  return `${title}\n\n${response.content}`;
}

function budgetFailure(used: number): ToolExecution {
  return failure(
    ERROR_CODES.E_BUDGET_EXCEEDED,
    `联网调用已达每任务上限 ${String(MAX_WEB_CALLS_PER_RUN)} 次（当前 ${String(used)} 次）。` +
      "请改用已经获得的结果，不要再调用 web_search / web_fetch。",
  );
}

// ── 工具实现 ─────────────────────────────────────────────────────

export async function webSearchTool(
  ctx: ToolContext,
  args: unknown,
): Promise<ToolExecution> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return failure(ERROR_CODES.E_INVALID_ARGUMENT, "web_search expects an object argument");
  }
  const record = args as Record<string, unknown>;

  let query: string;
  let count: number;
  let needContent: boolean;
  try {
    query = normalizeSearchQuery(record.query);
    count = normalizeSearchCount(
      record.count === undefined ? WEB_SEARCH_DEFAULT_TOOL_COUNT : record.count,
    );
    needContent = normalizeNeedContent(record.need_content);
  } catch (error) {
    const failed = toFailure(error);
    if (failed !== null) return failed;
    throw error;
  }

  let client: WebToolsClient;
  try {
    client = clientFor(ctx);
  } catch (error) {
    const failed = toFailure(error);
    if (failed !== null) return failed;
    throw error;
  }

  const budget = consumeWebCall(ctx);
  if (!budget.allowed) return budgetFailure(budget.used);

  let response: WebSearchResponse;
  try {
    response = await client.search({
      query,
      count,
      needContent,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    });
  } catch (error) {
    const failed = toFailure(error);
    if (failed !== null) return failed;
    throw error;
  }

  const formatted = formatSearchResult(response, query, needContent);
  const limited = truncateUtf8(formatted, maxOutputBytes(ctx), "输出已截断 / output truncated");
  return {
    ok: true,
    output: limited.output,
    preview: `web_search "${query}": ${String(response.results.length)} result(s)`,
    truncated: limited.truncated,
  };
}

export async function webFetchTool(
  ctx: ToolContext,
  args: unknown,
): Promise<ToolExecution> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return failure(ERROR_CODES.E_INVALID_ARGUMENT, "web_fetch expects an object argument");
  }
  const record = args as Record<string, unknown>;

  let url: string;
  try {
    url = normalizeFetchUrl(record.url);
  } catch (error) {
    const failed = toFailure(error);
    if (failed !== null) return failed;
    throw error;
  }

  let client: WebToolsClient;
  try {
    client = clientFor(ctx);
  } catch (error) {
    const failed = toFailure(error);
    if (failed !== null) return failed;
    throw error;
  }

  const budget = consumeWebCall(ctx);
  if (!budget.allowed) return budgetFailure(budget.used);

  let response: WebFetchResponse;
  try {
    response = await client.fetchPage({
      url,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    });
  } catch (error) {
    const failed = toFailure(error);
    if (failed !== null) return failed;
    throw error;
  }

  const formatted = formatFetchResult(response);
  const limited = truncateUtf8(formatted, maxOutputBytes(ctx), "输出已截断 / output truncated");
  return {
    ok: true,
    output: limited.output,
    preview: `web_fetch ${url}: ${String(Buffer.byteLength(response.content, "utf8"))} bytes`,
    truncated: limited.truncated,
  };
}

// ── 注册 ─────────────────────────────────────────────────────────

export function registerWebTools(): void {
  registerTool({ spec: WEB_SEARCH_SPEC, handler: webSearchTool });
  registerTool({ spec: WEB_FETCH_SPEC, handler: webFetchTool });
}

// 本模块没有反向依赖 executeTool（executeTool 不 import 本模块），
// 因此可以在求值完成时安全登记；装配层只需 import 本模块。
registerWebTools();
