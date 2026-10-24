/**
 * M11-01 验收：DeepSeek 官方联网工具
 *
 * 全部用 127.0.0.1 随机端口 mock server；不读 .env、不打真 API。
 * 覆盖：参数校验 / 成功解析 / 401 / 429 / 5xx / 50ms 超时 /
 * 每 run 30 次预算 / executeTool 事件成对 / ToolSpec / 装配链路。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { AGENT_TOOL_SPECS } from "../../src/agent/loop.ts";
import {
  TOOL_SPECS,
  createToolContext,
  executeTool,
  type CreateToolContextOptions,
  type ToolContext,
} from "../../src/agent/executeTool.ts";
import { buildAgentPrompt } from "../../src/agent/prompt.ts";
import {
  MAX_WEB_CALLS_PER_RUN,
  WEB_FETCH_SPEC,
  WEB_SEARCH_SPEC,
  WEB_TOOL_SPECS,
  getWebCallCount,
  installWebToolSpecs,
} from "../../src/agent/tools/web.ts";
import { ContractError, ERROR_CODES } from "../../src/core/errors.ts";
import type { LlmToolCall, TaskEvent } from "../../src/core/types.ts";
import { FakeProvider } from "../../src/providers/fake.ts";
import {
  WEB_FETCH_MAX_URL_CHARS,
  createWebToolsClient,
  normalizeFetchUrl,
  normalizeSearchCount,
  normalizeSearchQuery,
  type WebSearchItem,
} from "../../src/providers/web-tools.ts";
import { createTask } from "../../src/runtime/ops.ts";
import { createScheduler } from "../../src/runtime/scheduler.ts";
import { listEvents } from "../../src/store/events.ts";
import { openDatabase } from "../../src/store/migrate.ts";

const root = join(import.meta.dirname, "..", "..");
const TEST_KEY = "m11-test-key-not-a-real-secret";

// ── mock server（与 M2 验收同构）──────────────────────────────────

interface MockRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

interface MockServer {
  baseUrl: string;
  requests: MockRequest[];
  close: () => Promise<void>;
}

type MockHandler = (
  request: MockRequest,
  response: ServerResponse,
  index: number,
) => void;

async function startMockServer(handler: MockHandler): Promise<MockServer> {
  const requests: MockRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      const record: MockRequest = {
        method: request.method ?? "GET",
        url: request.url ?? "/",
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(record);
      try {
        handler(record, response, requests.length - 1);
      } catch {
        response.destroy();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo | string | null;
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("mock server 未能取得随机端口");
  }

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function payloadOf(event: TaskEvent | undefined): Record<string, unknown> {
  assert.ok(event !== undefined, "事件不存在");
  assert.ok(
    event.payload !== null && typeof event.payload === "object" && !Array.isArray(event.payload),
  );
  return event.payload as Record<string, unknown>;
}

function searchItem(overrides: Partial<WebSearchItem> = {}): Record<string, unknown> {
  return {
    rerank_score: 0.97,
    title: "DeepSeek 官方文档",
    url: "https://api-docs.deepseek.com/",
    snippet: "snippet-text",
    summary: "summary-text",
    content: "content-text",
    site_name: "DeepSeek",
    date: "2026-10-24",
    authority: "official",
    ...overrides,
  };
}

async function expectClientCode(
  promise: Promise<unknown>,
  code: string,
): Promise<ContractError> {
  let captured: ContractError | undefined;
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ContractError, `期望 ContractError，实际 ${String(error)}`);
    assert.equal(error.code, code);
    captured = error;
    return true;
  });
  assert.ok(captured !== undefined, "未捕获到 ContractError");
  return captured;
}

// ── 1. 客户端：search 成功解析 / 参数校验 / count 钳制 ─────────────

test("M11-01 search：参数校验、count 钳 1-20、成功解析全部字段", async () => {
  const mock = await startMockServer((_request, response) => {
    sendJson(response, 200, { results: [searchItem()] });
  });
  try {
    const client = createWebToolsClient({ apiKey: TEST_KEY, baseUrl: mock.baseUrl });

    const response = await client.search({
      query: "  DeepSeek 联网  ",
      count: 50,
      needContent: true,
    });
    assert.equal(response.results.length, 1);
    const item = response.results[0];
    assert.ok(item !== undefined);
    assert.equal(item.rerankScore, 0.97);
    assert.equal(item.title, "DeepSeek 官方文档");
    assert.equal(item.url, "https://api-docs.deepseek.com/");
    assert.equal(item.summary, "summary-text");
    assert.equal(item.content, "content-text");
    assert.equal(item.siteName, "DeepSeek");
    assert.equal(item.date, "2026-10-24");
    assert.equal(item.authority, "official");

    const first = mock.requests[0];
    assert.ok(first !== undefined);
    assert.equal(first.method, "POST");
    assert.equal(first.url, "/v1/tools/search");
    assert.equal(first.headers.authorization, `Bearer ${TEST_KEY}`);
    assert.deepEqual(JSON.parse(first.body), {
      query: "DeepSeek 联网",
      count: 20,
      need_content: true,
    });

    await client.search({ query: "x", count: 0 });
    await client.search({ query: "y", count: 8.9 });
    await client.search({ query: "z" });
    assert.equal(JSON.parse(mock.requests[1]?.body ?? "{}").count, 1);
    assert.equal(JSON.parse(mock.requests[2]?.body ?? "{}").count, 8);
    assert.equal(JSON.parse(mock.requests[3]?.body ?? "{}").count, 10);
    assert.equal(JSON.parse(mock.requests[3]?.body ?? "{}").need_content, false);

    // 参数错误必须在发网络之前拒绝。
    const before = mock.requests.length;
    await expectClientCode(
      client.search({ query: "" }),
      ERROR_CODES.E_INVALID_ARGUMENT,
    );
    await expectClientCode(
      client.search({ query: "a".repeat(129) }),
      ERROR_CODES.E_INVALID_ARGUMENT,
    );
    await expectClientCode(
      client.search({ query: "ok", count: "5" as unknown as number }),
      ERROR_CODES.E_INVALID_ARGUMENT,
    );
    await expectClientCode(
      client.search({ query: "ok", needContent: "yes" as unknown as boolean }),
      ERROR_CODES.E_INVALID_ARGUMENT,
    );
    assert.equal(mock.requests.length, before, "参数错误不得发请求");
    assert.equal(normalizeSearchQuery("  a  "), "a");
    assert.equal(normalizeSearchCount(999), 20);
  } finally {
    await mock.close();
  }
});

// ── 2. 客户端：fetch URL 校验与成功解析 ───────────────────────────

test("M11-01 fetch：拒绝非 http(s)、userinfo、缺 host、超长 URL；成功解析", async () => {
  const mock = await startMockServer((_request, response) => {
    sendJson(response, 200, { title: "示例页", content: "正文内容" });
  });
  try {
    const client = createWebToolsClient({ apiKey: TEST_KEY, baseUrl: mock.baseUrl });

    const response = await client.fetchPage({
      url: "https://example.com/a?b=1",
    });
    assert.equal(response.title, "示例页");
    assert.equal(response.content, "正文内容");

    const first = mock.requests[0];
    assert.ok(first !== undefined);
    assert.equal(first.method, "POST");
    assert.equal(first.url, "/v1/tools/fetch");
    assert.deepEqual(JSON.parse(first.body), { url: "https://example.com/a?b=1" });

    const before = mock.requests.length;
    const badUrls: unknown[] = [
      "ftp://example.com/a",
      "https://user:pass@example.com/a",
      "https://user@example.com/a",
      "http://",
      `https://example.com/${"a".repeat(WEB_FETCH_MAX_URL_CHARS)}`,
      42,
    ];
    for (const url of badUrls) {
      await expectClientCode(
        client.fetchPage({ url: url as string }),
        ERROR_CODES.E_INVALID_ARGUMENT,
      );
    }
    assert.equal(mock.requests.length, before, "非法 URL 不得发请求");

    assert.throws(
      () => normalizeFetchUrl("file:///etc/passwd"),
      (error: unknown) =>
        error instanceof ContractError && error.code === ERROR_CODES.E_INVALID_ARGUMENT,
    );
  } finally {
    await mock.close();
  }
});

// ── 3. 客户端：401 / 429 / 5xx 映射 + 错误脱敏 ───────────────────

test("M11-01 错误映射：401→AUTH、429→RATE_LIMIT、5xx→HTTP，且不含 apiKey", async () => {
  let status = 401;
  let longBody = false;
  const mock = await startMockServer((_request, response) => {
    const detail = longBody ? "x".repeat(1_000) : `mock ${String(status)}: ${TEST_KEY}`;
    sendJson(response, status, { error: { message: detail } });
  });
  try {
    const client = createWebToolsClient({ apiKey: TEST_KEY, baseUrl: mock.baseUrl });

    const auth = await expectClientCode(
      client.search({ query: "401" }),
      ERROR_CODES.E_PROVIDER_AUTH,
    );
    assert.ok(!auth.message.includes(TEST_KEY), `401 错误不得包含 key：${auth.message}`);
    assert.ok(auth.message.includes("[REDACTED]"), "401 错误体里的 key 应被脱敏");

    status = 429;
    const rate = await expectClientCode(
      client.search({ query: "429" }),
      ERROR_CODES.E_PROVIDER_RATE_LIMIT,
    );
    assert.ok(!rate.message.includes(TEST_KEY), `429 错误不得包含 key：${rate.message}`);

    status = 500;
    longBody = true;
    const http = await expectClientCode(
      client.search({ query: "500" }),
      ERROR_CODES.E_PROVIDER_HTTP,
    );
    assert.ok(http.message.includes("500"));
    assert.ok(http.message.length < 500, `错误详情应截断，实际 ${http.message.length} 字符`);
    assert.ok(!http.message.includes(TEST_KEY));
  } finally {
    await mock.close();
  }
});

// ── 4. 客户端：50ms 超时与调用方 abort ────────────────────────────

test("M11-01 超时：注入 50ms 超时映射 E_PROVIDER_TIMEOUT；调用方 abort 保留 AbortError", async () => {
  const mock = await startMockServer(() => {
    // 故意不响应。
  });
  try {
    const client = createWebToolsClient({
      apiKey: TEST_KEY,
      baseUrl: mock.baseUrl,
      timeoutMs: 50,
    });

    const started = Date.now();
    await expectClientCode(
      client.fetchPage({ url: "https://example.com/slow" }),
      ERROR_CODES.E_PROVIDER_TIMEOUT,
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1_000, `50ms 超时应快速触发，实际 ${elapsed}ms`);

    const controller = new AbortController();
    const pending = client.search({ query: "cancel", signal: controller.signal });
    setTimeout(() => controller.abort(new Error("test cancel")), 10);
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof DOMException, `期望 DOMException，实际 ${String(error)}`);
      assert.equal(error.name, "AbortError");
      return true;
    });
  } finally {
    await mock.close();
  }
});

// ── 5. executeTool：格式化、截断、事件成对、无 key 泄漏 ───────────

interface ToolFixture {
  base: string;
  workspace: string;
  db: DatabaseSync;
  makeCtx: (overrides?: Partial<CreateToolContextOptions>) => ToolContext;
}

async function withToolFixture(
  mock: MockServer,
  fn: (fixture: ToolFixture) => Promise<void>,
): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), "task-terminal-m11-"));
  const workspace = join(base, "workspace");
  mkdirSync(workspace);
  const db = openDatabase(":memory:");
  try {
    const makeCtx = (overrides: Partial<CreateToolContextOptions> = {}): ToolContext =>
      createToolContext({
        workspace,
        db,
        taskId: null,
        runId: "r_m11",
        permission: "read-only",
        timeoutMs: 5_000,
        outputDir: join(base, "outputs"),
        webTools: { apiKey: TEST_KEY, baseUrl: mock.baseUrl },
        ...overrides,
      });
    await fn({ base, workspace, db, makeCtx });
  } finally {
    db.close();
    rmSync(base, { recursive: true, force: true });
  }
}

test("M11-01 executeTool：search/fetch 格式化、正文截断、事件成对且无 key", async () => {
  const longContent = "A".repeat(25 * 1024);
  const mock = await startMockServer((request, response) => {
    if (request.url === "/v1/tools/search") {
      sendJson(response, 200, {
        results: [
          searchItem({
            title: "结果一",
            url: "https://example.com/one",
            summary: "摘要一",
            content: longContent,
            date: "2026-01-02",
            authority: "high",
          }),
        ],
      });
      return;
    }
    sendJson(response, 200, { title: "长网页", content: "B".repeat(4_000) });
  });

  try {
    await withToolFixture(mock, async ({ db, makeCtx }) => {
      const search = await executeTool(
        "web_search",
        { query: "deepseek 联网", count: 1, need_content: true },
        makeCtx(),
      );
      assert.equal(search.ok, true);
      for (const marker of [
        "结果一",
        "URL: https://example.com/one",
        "Date: 2026-01-02",
        "Authority: high",
        "Rerank: 0.97",
        "Summary: 摘要一",
        "Content:",
        "内容已截断",
      ]) {
        assert.ok(search.output.includes(marker), `搜索输出缺少 ${marker}`);
      }
      const sentSearch = JSON.parse(mock.requests[0]?.body ?? "{}");
      assert.equal(sentSearch.count, 1);
      assert.equal(sentSearch.need_content, true);

      const fetch = await executeTool(
        "web_fetch",
        { url: "https://example.com/long" },
        makeCtx({ maxOutputBytes: 512 }),
      );
      assert.equal(fetch.ok, true);
      assert.equal(fetch.truncated, true);
      assert.ok(Buffer.byteLength(fetch.output, "utf8") <= 512, "输出必须受 maxOutputBytes 限制");
      assert.ok(fetch.output.includes("长网页"));
      assert.ok(fetch.output.includes("输出已截断"));

      const events = listEvents(db);
      assert.equal(events.length, 4, `两次工具调用应恰好 4 条事件，实际 ${events.length}`);
      assert.deepEqual(
        events.map((event) => event.type),
        ["agent.tool_call", "agent.tool_result", "agent.tool_call", "agent.tool_result"],
      );
      assert.equal(payloadOf(events[0]).tool, "web_search");
      assert.equal(payloadOf(events[1]).ok, true);
      assert.equal(payloadOf(events[2]).tool, "web_fetch");
      assert.equal(payloadOf(events[3]).ok, true);
      const serialized = JSON.stringify(events);
      assert.ok(!serialized.includes(TEST_KEY), "事件流不得出现 apiKey");
    });
  } finally {
    await mock.close();
  }
});

// ── 6. 每 run 30 次预算（search 与 fetch 共享）─────────────────────

test("M11-01 预算：每 run 30 次联网调用，第 31 次结构化 E_BUDGET_EXCEEDED", async () => {
  const mock = await startMockServer((request, response) => {
    if (request.url === "/v1/tools/search") {
      sendJson(response, 200, { results: [searchItem()] });
      return;
    }
    sendJson(response, 200, { title: "页", content: "正文" });
  });

  try {
    await withToolFixture(mock, async ({ db, makeCtx }) => {
      const ctx = makeCtx();
      for (let index = 0; index < MAX_WEB_CALLS_PER_RUN; index += 1) {
        const result = await executeTool("web_search", { query: `q${String(index)}` }, ctx);
        assert.equal(result.ok, true, `第 ${String(index + 1)} 次应成功`);
      }
      assert.equal(getWebCallCount(ctx), MAX_WEB_CALLS_PER_RUN);
      assert.equal(mock.requests.length, MAX_WEB_CALLS_PER_RUN);

      const overflow = await executeTool("web_search", { query: "over" }, ctx);
      assert.equal(overflow.ok, false);
      assert.equal(overflow.code, ERROR_CODES.E_BUDGET_EXCEEDED);
      assert.ok(overflow.output.includes("30"), "失败信息应提示 30 次上限");
      assert.ok(overflow.output.includes("已经获得的结果"), "应提示改用已有结果");
      assert.equal(mock.requests.length, MAX_WEB_CALLS_PER_RUN, "超限后不得再发请求");

      const fetchOverflow = await executeTool(
        "web_fetch",
        { url: "https://example.com/late" },
        ctx,
      );
      assert.equal(fetchOverflow.ok, false);
      assert.equal(fetchOverflow.code, ERROR_CODES.E_BUDGET_EXCEEDED);
      assert.equal(mock.requests.length, MAX_WEB_CALLS_PER_RUN);

      const events = listEvents(db);
      const lastTwo = events.slice(-2);
      assert.equal(lastTwo[0]?.type, "agent.tool_call");
      assert.equal(lastTwo[1]?.type, "agent.tool_result");
      assert.equal(payloadOf(lastTwo[0]).tool, "web_fetch");
      assert.equal(payloadOf(lastTwo[1]).code, ERROR_CODES.E_BUDGET_EXCEEDED);
    });
  } finally {
    await mock.close();
  }
});

// ── 7. ToolSpec / 提示词 / 装配 / 脚本注册 ────────────────────────

function asRecord(value: unknown, label: string): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `预期 ${label} 是对象，实际 ${String(value)}`,
  );
  return value as Record<string, unknown>;
}

test("M11-01 ToolSpec：两个工具 schema 完整；prompt/index/package 已接线", () => {
  assert.deepEqual(
    WEB_TOOL_SPECS.map((spec) => spec.name),
    ["web_search", "web_fetch"],
  );
  assert.equal(TOOL_SPECS.some((spec) => spec.name.startsWith("web_")), false, "M3 六件套不扩容");

  const searchParameters = asRecord(WEB_SEARCH_SPEC.parameters, "web_search.parameters");
  assert.equal(searchParameters.type, "object");
  assert.equal(searchParameters.additionalProperties, false);
  assert.deepEqual(searchParameters.required, ["query"]);
  const searchProperties = asRecord(searchParameters.properties, "web_search.properties");
  assert.equal(asRecord(searchProperties.query, "query").maxLength, 128);
  const countProperty = asRecord(searchProperties.count, "count");
  assert.equal(countProperty.type, "integer");
  assert.equal(countProperty.maximum, 20);
  assert.equal(countProperty.default, 8);
  assert.equal(asRecord(searchProperties.need_content, "need_content").type, "boolean");

  const fetchParameters = asRecord(WEB_FETCH_SPEC.parameters, "web_fetch.parameters");
  assert.equal(fetchParameters.type, "object");
  assert.equal(fetchParameters.additionalProperties, false);
  assert.deepEqual(fetchParameters.required, ["url"]);
  const fetchProperties = asRecord(fetchParameters.properties, "web_fetch.properties");
  assert.equal(asRecord(fetchProperties.url, "url").maxLength, WEB_FETCH_MAX_URL_CHARS);

  const prompt = buildAgentPrompt({
    goal: "联网检索",
    workspace: "D:/workspace",
    permission: "read-only",
  });
  assert.ok(prompt.includes("需要联网信息时用 web_search 检索、web_fetch 读原文"));
  assert.ok(prompt.includes("优先用 summary"));
  assert.ok(prompt.includes("引用来源 URL"));
  assert.ok(prompt.includes("每任务最多 30 次"));

  const assembly = readFileSync(join(root, "src/index.ts"), "utf8");
  assert.ok(assembly.includes("installWebToolSpecs(AGENT_TOOL_SPECS)"));
  assert.ok(assembly.includes("webTools: {"));
  assert.ok(assembly.includes("apiKey: config.apiKey"));
  assert.ok(assembly.includes("ctx: schedulerCtx"));

  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  assert.ok(packageJson.scripts?.["verify"]?.includes("scripts/verify/m11.test.ts"));
  assert.ok(packageJson.scripts?.["verify:m11"]?.includes("scripts/verify/m11.test.ts"));
});

// ── 8. 装配链路：scheduler.ctx.webTools → loop → executeTool ───────

function loopCall(id: string, name: string, args: unknown): LlmToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

function submitCall(summary: string): LlmToolCall {
  return loopCall(`call_${summary}`, "submit_result", {
    summary,
    findings: [],
    artifacts: [],
  });
}

test("M11-01 装配链路：scheduler 的 ctx.webTools 透传，loop 收到并执行联网工具", async () => {
  installWebToolSpecs(AGENT_TOOL_SPECS);
  const mock = await startMockServer((_request, response) => {
    sendJson(response, 200, { results: [searchItem({ title: "装配链路结果" })] });
  });
  const base = mkdtempSync(join(tmpdir(), "task-terminal-m11-scheduler-"));
  const workspace = join(base, "workspace");
  mkdirSync(workspace);
  const db = openDatabase(join(base, "test.db"));
  try {
    const task = createTask(db, {
      title: "联网工具装配",
      goal: "检索并提交",
      workspace,
      permission: "read-only",
    });
    const provider = new FakeProvider([
      { toolCalls: [loopCall("call_web", "web_search", { query: "deepseek", count: 1 })] },
      { toolCalls: [submitCall("联网完成")] },
    ]);
    // 与 src/index.ts 相同：用变量承载 webTools，调度器靠 ...ctx 原样透传。
    const schedulerCtx = {
      outputDir: join(base, "outputs"),
      webTools: { apiKey: TEST_KEY, baseUrl: mock.baseUrl },
    };
    const scheduler = createScheduler({
      db,
      provider,
      ctx: schedulerCtx,
      reapOnStart: false,
    });

    const result = await scheduler.tick();
    assert.equal(result.started, true);
    if (!result.started) return;
    assert.equal(result.outcome.status, "completed", `期望 completed，实际 ${result.outcome.status}`);

    const firstCall = provider.calls[0];
    assert.ok(firstCall !== undefined);
    const toolNames = (firstCall.tools ?? []).map((tool) => tool.name);
    assert.ok(toolNames.includes("web_search"), "provider 未收到 web_search 声明");
    assert.ok(toolNames.includes("web_fetch"), "provider 未收到 web_fetch 声明");
    assert.equal(mock.requests.length, 1, "web_search 应真实打到 mock server");

    const events = listEvents(db, { taskId: task.id });
    const callIndex = events.findIndex(
      (event) =>
        event.type === "agent.tool_call" && payloadOf(event).tool === "web_search",
    );
    assert.ok(callIndex >= 0, "缺少 web_search 的 tool_call");
    const resultEvent = events[callIndex + 1];
    assert.equal(resultEvent?.type, "agent.tool_result");
    assert.equal(payloadOf(resultEvent).ok, true);
    const serialized = JSON.stringify(events);
    assert.ok(!serialized.includes(TEST_KEY), "任务事件不得出现 apiKey");
  } finally {
    db.close();
    rmSync(base, { recursive: true, force: true });
    await mock.close();
  }
});
