import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createServer,
  type IncomingHttpHeaders,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import {
  ContractError,
  ERROR_CODES,
  type ErrorCode,
} from "../../src/core/errors.ts";
import type { LlmResponse, TokenUsage } from "../../src/core/types.ts";
import { DeepSeekProvider } from "../../src/providers/deepseek.ts";
import { FakeProvider } from "../../src/providers/fake.ts";
import type { ChatParams, LlmStreamEvent } from "../../src/providers/types.ts";

const root = join(import.meta.dirname, "..", "..");
const TEST_KEY = "test-key-not-a-real-secret";

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
      } catch (error) {
        if (!response.headersSent) {
          sendJson(response, 500, { error: { message: String(error) } });
        } else {
          response.destroy();
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address() as AddressInfo | string | null;
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("mock server 未能取得随机端口");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}

function sendJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function openSse(response: ServerResponse): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  response.flushHeaders();
}

function sendSse(response: ServerResponse, payload: unknown): void {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function chatCompletion(
  content: string,
  usage?: Record<string, number>,
): Record<string, unknown> {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion",
    model: "deepseek-chat",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    ...(usage !== undefined ? { usage } : {}),
  };
}

async function expectCode(
  promise: Promise<unknown>,
  code: ErrorCode,
): Promise<ContractError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(
      error instanceof ContractError,
      `期望 ContractError(${code})，实际：${String(error)}`,
    );
    assert.equal(error.code, code, "错误码不符");
    return error;
  }
  assert.fail(`期望抛出 ${code}，实际成功`);
}

function collectStream(
  provider: DeepSeekProvider,
  params: ChatParams,
): Promise<{ events: LlmStreamEvent[]; texts: string[]; final: LlmResponse | null }> {
  return (async () => {
    const events: LlmStreamEvent[] = [];
    const texts: string[] = [];
    let final: LlmResponse | null = null;
    for await (const event of provider.stream(params)) {
      events.push(event);
      if (event.type === "text_delta") texts.push(event.text);
      if (event.type === "done") {
        assert.equal(final, null, "done 事件必须恰好一次");
        final = event.response;
      }
    }
    return { events, texts, final };
  })();
}

// ── 非流式 ───────────────────────────────────────────────────────

test("M2-01 非流式 chat 返回 content 与 usage 三项映射", async () => {
  const mock = await startMockServer((_request, response) => {
    sendJson(
      response,
      200,
      chatCompletion("你好，世界", {
        prompt_tokens: 12,
        prompt_cache_hit_tokens: 5,
        completion_tokens: 34,
        total_tokens: 46,
      }),
    );
  });
  try {
    const provider = new DeepSeekProvider({
      apiKey: TEST_KEY,
      baseUrl: mock.baseUrl,
    });
    const response = await provider.chat({
      messages: [{ role: "user", content: "说句话" }],
      tools: [
        {
          name: "read_file",
          description: "读取文件",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ],
    });

    assert.equal(response.content, "你好，世界", "content 不一致");
    assert.deepEqual(response.toolCalls, [], "无工具调用时 toolCalls 应为空数组");
    assert.equal(response.finishReason, "stop", "finishReason 不一致");
    const usage = response.usage;
    assert.ok(usage !== undefined, "usage 不应缺失");
    assert.equal(usage.inputTokens, 12, "inputTokens 映射错误");
    assert.equal(usage.cachedTokens, 5, "cachedTokens 映射错误");
    assert.equal(usage.outputTokens, 34, "outputTokens 映射错误");
    assert.equal(usage.estimated, false, "有 usage 时 estimated 应为 false");

    const first = mock.requests[0];
    assert.ok(first !== undefined, "mock 应收到一次请求");
    assert.equal(first.method, "POST", "非流式应 POST /chat/completions");
    assert.equal(
      first.headers.authorization,
      `Bearer ${TEST_KEY}`,
      "Authorization 头不符",
    );
    const sent = JSON.parse(first.body) as {
      model?: string;
      stream?: boolean;
      tools?: Array<{ type?: string; function?: { name?: string } }>;
      tool_choice?: string;
    };
    assert.equal(sent.model, "deepseek-chat", "默认模型应为 deepseek-chat");
    assert.equal(sent.stream, false, "非流式请求 stream 应为 false");
    assert.equal(sent.tools?.[0]?.type, "function", "tools 应映射为 function");
    assert.equal(sent.tools?.[0]?.function?.name, "read_file", "工具名映射错误");
    assert.equal(sent.tool_choice, "auto", "有 tools 时应带 tool_choice=auto");
  } finally {
    await mock.close();
  }
});

test("M2-01 usage 缺失时按字符数/2 估算并标记 estimated", async () => {
  const content = "一二三四五六七八";
  const mock = await startMockServer((_request, response) => {
    sendJson(response, 200, chatCompletion(content));
  });
  try {
    const provider = new DeepSeekProvider({
      apiKey: TEST_KEY,
      baseUrl: mock.baseUrl,
    });
    const response = await provider.chat({
      messages: [{ role: "user", content: "1234" }],
    });
    const usage = response.usage;
    assert.ok(usage !== undefined, "估算 usage 不应缺失");
    assert.equal(usage.estimated, true, "缺 usage 时 estimated 应为 true");
    assert.equal(usage.outputTokens, Math.ceil(content.length / 2), "输出估算不符");
    assert.ok(usage.inputTokens > 0, "输入估算应大于 0");
    assert.equal(usage.cachedTokens, 0, "估算时 cachedTokens 应为 0");
  } finally {
    await mock.close();
  }
});

// ── 流式 ─────────────────────────────────────────────────────────

test("M2-01 流式纯文本按序增量，最终 content 完整且 usage 来自末帧", async () => {
  const mock = await startMockServer((_request, response) => {
    openSse(response);
    sendSse(response, {
      choices: [{ index: 0, delta: { role: "assistant", content: "" } }],
    });
    sendSse(response, { choices: [{ index: 0, delta: { content: "你" } }] });
    sendSse(response, { choices: [{ index: 0, delta: { content: "好" } }] });
    sendSse(response, {
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    });
    sendSse(response, {
      choices: [],
      usage: {
        prompt_tokens: 11,
        prompt_cache_hit_tokens: 3,
        completion_tokens: 7,
      },
    });
    response.end("data: [DONE]\n\n");
  });
  try {
    const provider = new DeepSeekProvider({
      apiKey: TEST_KEY,
      baseUrl: mock.baseUrl,
    });
    const { events, texts, final } = await collectStream(provider, {
      messages: [{ role: "user", content: "打招呼" }],
    });

    assert.deepEqual(texts, ["你", "好"], "文本增量顺序不符");
    assert.ok(final !== null, "流式结束必须交付最终响应");
    assert.equal(final.content, "你好", "最终 content 不完整");
    assert.deepEqual(final.toolCalls, [], "纯文本不应有 toolCalls");
    const usage: TokenUsage | undefined = final.usage;
    assert.ok(usage !== undefined, "最终响应应带 usage");
    assert.equal(usage.inputTokens, 11, "inputTokens 映射错误");
    assert.equal(usage.cachedTokens, 3, "cachedTokens 映射错误");
    assert.equal(usage.outputTokens, 7, "outputTokens 映射错误");
    assert.equal(usage.estimated, false, "末帧有 usage 时 estimated 应为 false");
    assert.equal(
      events[events.length - 1]?.type,
      "done",
      "done 必须是最后一个事件",
    );

    const first = mock.requests[0];
    assert.ok(first !== undefined, "mock 应收到一次请求");
    const sent = JSON.parse(first.body) as {
      stream?: boolean;
      stream_options?: { include_usage?: boolean };
    };
    assert.equal(sent.stream, true, "流式请求 stream 应为 true");
    assert.equal(
      sent.stream_options?.include_usage,
      true,
      "流式请求必须带 include_usage",
    );
  } finally {
    await mock.close();
  }
});

test("M2-01 流式 tool_calls 分片拼接后才交付完整参数", async () => {
  const args = '{"path":"a.txt"}';
  const mock = await startMockServer((_request, response) => {
    openSse(response);
    sendSse(response, {
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "read_file", arguments: "" },
              },
            ],
          },
        },
      ],
    });
    sendSse(response, {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '{"pa' } }],
          },
        },
      ],
    });
    sendSse(response, {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"' } }],
          },
        },
      ],
    });
    sendSse(response, {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, function: { arguments: "}" } }],
          },
        },
      ],
    });
    sendSse(response, {
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "tool_calls",
        },
      ],
    });
    sendSse(response, {
      choices: [],
      usage: { prompt_tokens: 21, completion_tokens: 9 },
    });
    response.end("data: [DONE]\n\n");
  });
  try {
    const provider = new DeepSeekProvider({
      apiKey: TEST_KEY,
      baseUrl: mock.baseUrl,
    });
    const { events, final } = await collectStream(provider, {
      messages: [{ role: "user", content: "读取 a.txt" }],
      tools: [{ name: "read_file", description: "读文件", parameters: {} }],
    });

    const deltas = events.filter((event) => event.type === "tool_call_delta");
    assert.ok(deltas.length > 0, "应收到 tool_call 分片事件");
    let assembled = "";
    for (const delta of deltas) {
      if (delta.type === "tool_call_delta") assembled += delta.argumentsDelta;
    }
    assert.equal(assembled, args, "分片拼接结果不一致");

    assert.ok(final !== null, "流式结束必须交付最终响应");
    assert.equal(final.toolCalls.length, 1, "应产出 1 个工具调用");
    const call = final.toolCalls[0];
    assert.ok(call !== undefined, "工具调用缺失");
    assert.equal(call.id, "call_1", "tool_call id 不一致");
    assert.equal(call.function.name, "read_file", "tool_call name 不一致");
    assert.equal(call.function.arguments, args, "最终参数必须是完整 JSON 串");
    assert.deepEqual(
      JSON.parse(call.function.arguments) as unknown,
      { path: "a.txt" },
      "最终参数应可 JSON.parse",
    );
    assert.equal(final.finishReason, "tool_calls", "finishReason 不一致");

    const doneEvents = events.filter((event) => event.type === "done");
    assert.equal(doneEvents.length, 1, "done 必须恰好一次");
    assert.equal(
      events[events.length - 1]?.type,
      "done",
      "done 必须是最后一个事件，中途不得交付半成品",
    );
  } finally {
    await mock.close();
  }
});

test("M2-01 [DONE] 与空帧 / 注释帧处理正确", async () => {
  const mock = await startMockServer((_request, response) => {
    openSse(response);
    response.write(": keep-alive\n\n");
    response.write("data: \n\n");
    response.write("data:\n\n");
    sendSse(response, { choices: [{ index: 0, delta: { content: "A" } }] });
    sendSse(response, { choices: [{ index: 0, delta: { content: "B" } }] });
    response.write(
      'data: [DONE]\n\ndata: {"choices":[{"index":0,"delta":{"content":"不应出现"}}]}\n\n',
    );
    response.end();
  });
  try {
    const provider = new DeepSeekProvider({
      apiKey: TEST_KEY,
      baseUrl: mock.baseUrl,
    });
    const { events, texts, final } = await collectStream(provider, {
      messages: [{ role: "user", content: "空帧测试" }],
    });
    assert.deepEqual(texts, ["A", "B"], "空帧/注释帧不应影响文本增量");
    assert.ok(final !== null, "应交付最终响应");
    assert.equal(final.content, "AB", "[DONE] 之后的数据不应再处理");
    assert.equal(
      events.filter((event) => event.type === "done").length,
      1,
      "done 必须恰好一次",
    );
  } finally {
    await mock.close();
  }
});

// ── 错误与重试 ───────────────────────────────────────────────────

test("M2-01 401 / 400 / 402 不重试并映射错误码，错误信息不含 key", async () => {
  let status = 401;
  const mock = await startMockServer((_request, response) => {
    sendJson(response, status, {
      error: { message: `mock ${status}: ${TEST_KEY}` },
    });
  });
  try {
    const provider = new DeepSeekProvider({
      apiKey: TEST_KEY,
      baseUrl: mock.baseUrl,
      retry: { maxRetries: 3, baseDelayMs: 1 },
    });
    const params = { messages: [{ role: "user" as const, content: "x" }] };

    const authError = await expectCode(
      provider.chat(params),
      ERROR_CODES.E_PROVIDER_AUTH,
    );
    assert.equal(mock.requests.length, 1, "401 不应重试");
    assert.ok(
      !authError.message.includes(TEST_KEY),
      `错误信息不得包含 key，实际：${authError.message}`,
    );
    assert.ok(
      authError.message.includes("[REDACTED]"),
      "错误体中的 key 应被脱敏",
    );

    status = 400;
    const badRequest = await expectCode(
      provider.chat(params),
      ERROR_CODES.E_PROVIDER_HTTP,
    );
    assert.equal(mock.requests.length, 2, "400 不应重试");
    assert.ok(
      badRequest.message.includes("参数错误") && badRequest.message.includes("bug"),
      `400 错误信息应注明参数错误视为 bug，实际：${badRequest.message}`,
    );

    status = 402;
    await expectCode(provider.chat(params), ERROR_CODES.E_PROVIDER_QUOTA);
    assert.equal(mock.requests.length, 3, "402 不应重试");
  } finally {
    await mock.close();
  }
});

test("M2-01 429 尊重 Retry-After 后退避成功", async () => {
  const mock = await startMockServer((_request, response, index) => {
    if (index === 0) {
      response.setHeader("retry-after", "0.05");
      sendJson(response, 429, { error: { message: "rate limited" } });
      return;
    }
    sendJson(response, 200, chatCompletion("恢复"));
  });
  try {
    const provider = new DeepSeekProvider({
      apiKey: TEST_KEY,
      baseUrl: mock.baseUrl,
      retry: { maxRetries: 3, baseDelayMs: 1 },
    });
    const started = Date.now();
    const response = await provider.chat({
      messages: [{ role: "user", content: "重试" }],
    });
    const elapsed = Date.now() - started;
    assert.equal(response.content, "恢复", "429 后应成功");
    assert.ok(mock.requests.length >= 2, `期望至少 2 次请求，实际 ${mock.requests.length}`);
    assert.ok(
      elapsed >= 40,
      `应尊重 Retry-After=0.05s（等待 ≥40ms），实际 ${elapsed}ms`,
    );
  } finally {
    await mock.close();
  }
});

test("M2-01 连续 429 三次重试耗尽抛 E_PROVIDER_RATE_LIMIT", async () => {
  const mock = await startMockServer((_request, response) => {
    sendJson(response, 429, { error: { message: "rate limited" } });
  });
  try {
    const provider = new DeepSeekProvider({
      apiKey: TEST_KEY,
      baseUrl: mock.baseUrl,
      retry: { maxRetries: 3, baseDelayMs: 1 },
    });
    await expectCode(
      provider.chat({ messages: [{ role: "user", content: "一直限流" }] }),
      ERROR_CODES.E_PROVIDER_RATE_LIMIT,
    );
    assert.equal(
      mock.requests.length,
      4,
      `首次 + 3 次重试应共 4 次请求，实际 ${mock.requests.length}`,
    );
  } finally {
    await mock.close();
  }
});

test("M2-01 500 / 503 也按指数退避重试", async () => {
  const mock = await startMockServer((_request, response, index) => {
    if (index === 0) {
      sendJson(response, 503, { error: { message: "unavailable" } });
      return;
    }
    sendJson(response, 200, chatCompletion("服务恢复"));
  });
  try {
    const provider = new DeepSeekProvider({
      apiKey: TEST_KEY,
      baseUrl: mock.baseUrl,
      retry: { maxRetries: 3, baseDelayMs: 1 },
    });
    const response = await provider.chat({
      messages: [{ role: "user", content: "503" }],
    });
    assert.equal(response.content, "服务恢复", "503 后应重试成功");
    assert.equal(mock.requests.length, 2, "应发生一次重试");
  } finally {
    await mock.close();
  }
});

// ── 取消与超时 ───────────────────────────────────────────────────

test("M2-01 调用方 AbortSignal 中止抛 AbortError（区别于超时）", async () => {
  const mock = await startMockServer(() => {
    // 故意不响应，等待调用方 abort。
  });
  try {
    const provider = new DeepSeekProvider({
      apiKey: TEST_KEY,
      baseUrl: mock.baseUrl,
      timeouts: { connectMs: 2_000, readMs: 2_000 },
    });
    const controller = new AbortController();
    const pending = provider.chat({
      messages: [{ role: "user", content: "取消" }],
      signal: controller.signal,
    });
    setTimeout(() => {
      controller.abort();
    }, 20);

    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof DOMException, `期望 AbortError，实际 ${String(error)}`);
      assert.equal(error.name, "AbortError", "错误名应为 AbortError");
      return true;
    });
  } finally {
    await mock.close();
  }
});

test("M2-01 流式首 token 超时抛 E_PROVIDER_TIMEOUT", async () => {
  const mock = await startMockServer((_request, response) => {
    openSse(response);
    response.write(": keep-alive\n\n");
    // 不再发送任何 data 帧，等待 provider 首 token 超时。
  });
  try {
    const provider = new DeepSeekProvider({
      apiKey: TEST_KEY,
      baseUrl: mock.baseUrl,
      timeouts: { connectMs: 5_000, readMs: 5_000, firstTokenMs: 50 },
      retry: { maxRetries: 0, baseDelayMs: 1 },
    });
    const started = Date.now();
    await assert.rejects(
      async () => {
        for await (const _event of provider.stream({
          messages: [{ role: "user", content: "超时" }],
        })) {
          // 不应收到任何事件。
        }
      },
      (error: unknown) => {
        assert.ok(error instanceof ContractError, `期望 ContractError，实际 ${String(error)}`);
        assert.equal(error.code, ERROR_CODES.E_PROVIDER_TIMEOUT, "错误码应为超时");
        return true;
      },
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1_000, `首 token 超时应快速触发，实际 ${elapsed}ms`);
  } finally {
    await mock.close();
  }
});

// ── 余额与假 provider ────────────────────────────────────────────

test("M2-01 checkBalance 解析余额，余额不足抛 E_PROVIDER_QUOTA", async () => {
  let available = true;
  let chatStatus = 200;
  const mock = await startMockServer((request, response) => {
    if (request.url === "/user/balance") {
      sendJson(response, 200, {
        is_available: available,
        balance_infos: [
          {
            currency: "CNY",
            total_balance: available ? "12.34" : "0.00",
            granted_balance: "0.00",
            topped_up_balance: available ? "12.34" : "0.00",
          },
        ],
      });
      return;
    }
    if (chatStatus !== 200) {
      sendJson(response, chatStatus, { error: { message: "payment required" } });
      return;
    }
    sendJson(response, 200, chatCompletion("ok"));
  });
  try {
    const provider = new DeepSeekProvider({
      apiKey: TEST_KEY,
      baseUrl: mock.baseUrl,
      retry: { maxRetries: 0, baseDelayMs: 1 },
    });
    const balance = await provider.checkBalance();
    assert.equal(balance.isAvailable, true, "余额可用标记不符");
    assert.equal(balance.balances[0]?.currency, "CNY", "币种不符");
    assert.equal(balance.balances[0]?.totalBalance, "12.34", "余额值不符");
    const first = mock.requests[0];
    assert.ok(first !== undefined, "应请求余额接口");
    assert.equal(first.method, "GET", "余额接口应为 GET");
    assert.equal(first.url, "/user/balance", "余额接口路径不符");
    assert.equal(
      first.headers.authorization,
      `Bearer ${TEST_KEY}`,
      "余额请求也应带 Authorization",
    );

    available = false;
    await expectCode(provider.checkBalance(), ERROR_CODES.E_PROVIDER_QUOTA);

    available = true;
    chatStatus = 402;
    await expectCode(
      provider.chat({ messages: [{ role: "user", content: "402" }] }),
      ERROR_CODES.E_PROVIDER_QUOTA,
    );
  } finally {
    await mock.close();
  }
});

test("M2-01 假 provider 三步脚本按序吐出，并可注入一次错误", async () => {
  const fake = new FakeProvider([
    { content: "第一步" },
    {
      content: null,
      toolCalls: [
        {
          id: "call_fake_1",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"a.txt"}' },
        },
      ],
    },
    { content: "第三步" },
  ]);

  const first = await fake.chat({ messages: [{ role: "user", content: "1" }] });
  assert.equal(first.content, "第一步", "假 provider 第一步不符");

  const streamEvents: LlmStreamEvent[] = [];
  for await (const event of fake.stream({
    messages: [{ role: "user", content: "2" }],
  })) {
    streamEvents.push(event);
  }
  const done = streamEvents.find((event) => event.type === "done");
  assert.ok(done !== undefined && done.type === "done", "假 provider 流式应交付 done");
  assert.equal(done.response.toolCalls.length, 1, "假 provider 工具调用缺失");
  assert.equal(
    done.response.toolCalls[0]?.function.arguments,
    '{"path":"a.txt"}',
    "假 provider 工具参数不一致",
  );

  const third = await fake.chat({ messages: [{ role: "user", content: "3" }] });
  assert.equal(third.content, "第三步", "假 provider 第三步不符");
  assert.equal(fake.pending, 0, "三步应恰好消费完");
  assert.equal(fake.calls.length, 3, "应记录 3 次调用");

  const flaky = new FakeProvider([
    { error: new Error("boom") },
    { content: "恢复" },
  ]);
  await assert.rejects(
    flaky.chat({ messages: [] }),
    /boom/,
    "注入的错误应抛出",
  );
  const recovered = await flaky.chat({ messages: [] });
  assert.equal(recovered.content, "恢复", "错误步被消费后应恢复");

  const chunked = new FakeProvider([{ textDeltas: ["分", "片"] }]);
  const chunkedEvents: LlmStreamEvent[] = [];
  for await (const event of chunked.stream({ messages: [] })) {
    chunkedEvents.push(event);
  }
  const chunkedTexts = chunkedEvents
    .filter((event) => event.type === "text_delta")
    .map((event) => (event.type === "text_delta" ? event.text : ""));
  assert.deepEqual(chunkedTexts, ["分", "片"], "假 provider 应支持文本分片");
  const chunkedDone = chunkedEvents.find((event) => event.type === "done");
  assert.ok(
    chunkedDone !== undefined && chunkedDone.type === "done",
    "分片脚本也应交付 done",
  );
  assert.equal(chunkedDone.response.content, "分片", "分片脚本最终 content 不一致");
});

// ── 工程注册 ─────────────────────────────────────────────────────

test("M2-01 package.json 注册 verify:m2 且总 verify 包含 m0/m1/m2", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  assert.ok(
    pkg.scripts?.["verify:m2"]?.includes("scripts/verify/m2.test.ts"),
    "缺少 verify:m2 或未指向 m2 测试",
  );
  assert.ok(
    pkg.scripts?.verify?.includes("scripts/verify/m2.test.ts"),
    "总 verify 未包含 m2",
  );
  assert.ok(
    pkg.scripts?.verify?.includes("scripts/verify/m0.test.ts"),
    "总 verify 不应丢失 m0",
  );
  assert.ok(
    pkg.scripts?.verify?.includes("scripts/verify/m1.test.ts"),
    "总 verify 不应丢失 m1",
  );
});
