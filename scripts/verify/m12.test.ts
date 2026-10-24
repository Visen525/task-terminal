import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { ContractError, ERROR_CODES } from "../../src/core/errors.ts";
import { llmContentText } from "../../src/core/types.ts";
import {
  buildMainContext,
  gatherMainContext,
} from "../../src/agent/context.ts";
import {
  formatSummaryBlock,
  maybeCompactSummary,
} from "../../src/agent/conversation-summary.ts";
import { runMainTurn } from "../../src/agent/main-loop.ts";
import { DeepSeekProvider } from "../../src/providers/deepseek.ts";
import { FakeProvider } from "../../src/providers/fake.ts";
import type {
  BalanceInfo,
  ChatParams,
  LlmProvider,
  LlmStreamEvent,
} from "../../src/providers/types.ts";
import { createScheduler, type Scheduler } from "../../src/runtime/scheduler.ts";
import { createApp } from "../../src/server/index.ts";
import { upsertFact } from "../../src/store/facts.ts";
import { openDatabase } from "../../src/store/migrate.ts";
import { appendMessage } from "../../src/store/messages.ts";
import {
  DEFAULT_SETTINGS,
  getEffectiveApiKey,
  getSettings,
  saveSettings,
  validateSettingsInput,
} from "../../src/store/settings.ts";

const TEST_KEY = "sk-test-12345678";
const ENV_KEY = "sk-env-abcdefgh";
const TEST_KEY_TAIL = TEST_KEY.slice(-4);

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function withDb(fn: (db: DatabaseSync) => Promise<void> | void): Promise<void> {
  const dir = tempDir("task-terminal-m12-db-");
  const db = openDatabase(join(dir, "test.db"));
  try {
    await fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 测试绝不读取真实 .env：每个用例显式清空 DEEPSEEK_API_KEY，结束后恢复。 */
async function withoutEnvKey(fn: () => Promise<void> | void): Promise<void> {
  const previous = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previous;
  }
}

function stubScheduler(): Scheduler {
  return {
    tick: async () => ({ started: false, reason: "empty" }),
    runAll: async () => [],
    shutdown: async () => undefined,
    cancel: () => false,
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  assert.ok(
    typeof value === "object" && value !== null && !Array.isArray(value),
    `预期 ${label} 是对象，实际 ${String(value)}`,
  );
  return value as Record<string, unknown>;
}

/** 轮询等待 fire-and-forget 的摘要任务落库/告警，避免用固定 sleep 猜时序。 */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`等待超时：${label}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function promptOf(call: ChatParams | undefined): string {
  assert.ok(call !== undefined, "provider 调用不存在");
  return call.messages.map((message) => llmContentText(message.content)).join("\n");
}

/** 预写 N 轮主线对话；第 2 轮带唯一标记，第 9 轮带窗口标记。 */
function seedMainTurns(db: DatabaseSync, total: number): void {
  for (let turn = 1; turn <= total; turn += 1) {
    const marker = turn === 2 ? "原始第2轮问题" : `第${turn}轮用户原文`;
    appendMessage(db, {
      role: "user",
      content: `${marker}：用户内容 ${turn}`,
      ts: turn * 2,
    });
    appendMessage(db, {
      role: "assistant",
      content: `第${turn}轮助手原文：助手内容 ${turn}`,
      ts: turn * 2 + 1,
    });
  }
}

function summaryRows(
  db: DatabaseSync,
): Array<{ purpose: string; model: string; input_tokens: number; output_tokens: number }> {
  return db
    .prepare(
      "SELECT purpose, model, input_tokens, output_tokens FROM llm_calls WHERE purpose = 'summary' ORDER BY ts ASC",
    )
    .all() as unknown as Array<{
    purpose: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
  }>;
}

function assertInvalidApiKey(value: unknown): void {
  assert.throws(
    () => validateSettingsInput({ apiKey: value }),
    (error: unknown) =>
      error instanceof ContractError &&
      error.code === ERROR_CODES.E_INVALID_ARGUMENT &&
      error.message.includes("apiKey"),
    `预期 apiKey=${JSON.stringify(value)} 校验失败`,
  );
}

function providerWithBalance(
  checkBalance: (signal?: AbortSignal) => Promise<BalanceInfo>,
): LlmProvider {
  return {
    chat: async (_params: ChatParams) => {
      throw new Error("本用例不调用 chat");
    },
    stream: async function* (): AsyncGenerator<LlmStreamEvent> {
      // 空流；本用例只测 checkBalance。
    },
    checkBalance,
  };
}

// ════════════════════════════════════════════════════════════════
// 1. settings：apiKey 存取/校验/优先级
// ════════════════════════════════════════════════════════════════

test("M12-01 settings：apiKey 默认 null、存取、校验与 settings > env 优先级", async () => {
  await withDb(async (db) => {
    await withoutEnvKey(async () => {
      assert.equal(DEFAULT_SETTINGS.apiKey, null, "默认 apiKey 必须是 null");
      assert.equal(getSettings(db).apiKey, null);
      assert.equal(getSettings(db).hasApiKey, false);
      assert.equal(getSettings(db).apiKeyTail, null);
      assert.equal(getSettings(db).apiKeySource, null);
      assert.equal(getEffectiveApiKey(db), null);

      const saved = saveSettings(db, { apiKey: TEST_KEY }, 1_000);
      assert.equal(saved.apiKey, TEST_KEY);
      assert.equal(saved.hasApiKey, true);
      assert.equal(saved.apiKeyTail, TEST_KEY_TAIL);
      assert.equal(saved.apiKeySource, "settings");
      assert.equal(getEffectiveApiKey(db), TEST_KEY);

      // 明文只应存在库内，不应被通用 JSON 序列化带出。
      assert.ok(
        !JSON.stringify(getSettings(db)).includes(TEST_KEY),
        "settings 的 JSON 序列化不得包含 key 明文",
      );
      const row = db
        .prepare("SELECT value FROM app_settings WHERE key = 'app'")
        .get() as unknown as { value: string };
      assert.equal(JSON.parse(row.value).apiKey, TEST_KEY, "钥匙应落库");

      process.env.DEEPSEEK_API_KEY = ENV_KEY;
      assert.equal(getEffectiveApiKey(db), TEST_KEY, "settings 必须优先于 env");

      saveSettings(db, { apiKey: null }, 1_001);
      assert.equal(getEffectiveApiKey(db), ENV_KEY, "清除后回退 env");
      assert.equal(getSettings(db).apiKeySource, "env");
      assert.equal(getSettings(db).apiKeyTail, ENV_KEY.slice(-4));

      delete process.env.DEEPSEEK_API_KEY;
      assert.equal(getEffectiveApiKey(db), null);
    });
  });

  // 合法值：允许首尾空白，落库前 trim；不强制 sk- 前缀，但不能有内部空白。
  assert.equal(validateSettingsInput({ apiKey: `  ${TEST_KEY}  ` }).apiKey, TEST_KEY);
  assert.equal(validateSettingsInput({ apiKey: null }).apiKey, null);

  for (const invalid of [
    "",
    "short",
    "x".repeat(201),
    "sk-test 12345678",
    "sk-test\t12345678",
    12345678,
  ]) {
    assertInvalidApiKey(invalid);
  }
});

// ════════════════════════════════════════════════════════════════
// 2. GET/PUT /settings：不回明文，PUT 后立即生效
// ════════════════════════════════════════════════════════════════

test("M12-01 routes：GET/PUT /settings 只回 hasApiKey/尾号/来源，PUT 后生效", async () => {
  const workspace = tempDir("task-terminal-m12-settings-ws-");
  await withDb(async (db) => {
    await withoutEnvKey(async () => {
      const app = createApp({
        db,
        scheduler: stubScheduler(),
        defaultWorkspace: workspace,
      });
      try {
        const initial = await app.inject({ method: "GET", url: "/settings" });
        assert.equal(initial.statusCode, 200);
        const initialBody = asRecord(initial.json(), "initial settings");
        assert.equal(initialBody.hasApiKey, false);
        assert.equal(initialBody.apiKeyTail, null);
        assert.equal(initialBody.apiKeySource, null);
        assert.equal(initialBody.apiKey, undefined, "GET 不得出现 apiKey 字段");
        assert.ok(!initial.body.includes(TEST_KEY), "GET 初始响应不得含 key");

        const saved = await app.inject({
          method: "PUT",
          url: "/settings",
          payload: { apiKey: TEST_KEY },
        });
        assert.equal(saved.statusCode, 200);
        assert.ok(!saved.body.includes(TEST_KEY), "PUT 响应不得含 key 明文");
        const savedBody = asRecord(saved.json(), "saved settings");
        assert.equal(savedBody.hasApiKey, true);
        assert.equal(savedBody.apiKeyTail, TEST_KEY_TAIL);
        assert.equal(savedBody.apiKeySource, "settings");
        assert.equal(savedBody.apiKey, undefined, "PUT 响应不得出现 apiKey 字段");
        assert.equal(getEffectiveApiKey(db), TEST_KEY, "PUT 写库后立即生效");

        const reread = await app.inject({ method: "GET", url: "/settings" });
        assert.equal(reread.statusCode, 200);
        assert.ok(!reread.body.includes(TEST_KEY), "GET 响应全文不得含 key");
        const rereadBody = asRecord(reread.json(), "reread settings");
        assert.equal(rereadBody.hasApiKey, true);
        assert.equal(rereadBody.apiKeyTail, TEST_KEY_TAIL);
        assert.equal(rereadBody.apiKeySource, "settings");

        // 客户端把 GET 的整份响应 PUT 回来也不应被派生字段弄成 400。
        const roundTrip = await app.inject({
          method: "PUT",
          url: "/settings",
          payload: rereadBody,
        });
        assert.equal(roundTrip.statusCode, 200);
        assert.equal(getEffectiveApiKey(db), TEST_KEY);

        const cleared = await app.inject({
          method: "PUT",
          url: "/settings",
          payload: { apiKey: null },
        });
        assert.equal(cleared.statusCode, 200);
        const clearedBody = asRecord(cleared.json(), "cleared settings");
        assert.equal(clearedBody.hasApiKey, false);
        assert.equal(clearedBody.apiKeyTail, null);
        assert.equal(getEffectiveApiKey(db), null);

        // env 回退：来源变成 .env，尾号来自 env key。
        process.env.DEEPSEEK_API_KEY = ENV_KEY;
        const fromEnv = await app.inject({ method: "GET", url: "/settings" });
        const envBody = asRecord(fromEnv.json(), "env settings");
        assert.equal(envBody.hasApiKey, true);
        assert.equal(envBody.apiKeyTail, ENV_KEY.slice(-4));
        assert.equal(envBody.apiKeySource, "env");
        assert.ok(!fromEnv.body.includes(ENV_KEY), "env key 也不得出现在 GET");
      } finally {
        await app.close();
      }
    });
  });
  rmSync(workspace, { recursive: true, force: true });
});

// ════════════════════════════════════════════════════════════════
// 3. 无 key：createApp 可构造、chat 503、任务可建但 tick 不启动
// ════════════════════════════════════════════════════════════════

test("M12-01 无 key：服务可构造、POST /chat 503 中文指引、任务创建但调度 tick no-key", async () => {
  const workspace = tempDir("task-terminal-m12-nokey-ws-");
  await withDb(async (db) => {
    await withoutEnvKey(async () => {
      const provider = new FakeProvider([{ content: "不应被调用" }]);
      const scheduler = createScheduler({
        db,
        provider,
        reapOnStart: false,
        getApiKey: () => getEffectiveApiKey(db),
      });
      const app = createApp({
        db,
        scheduler,
        mainAi: { provider },
        defaultWorkspace: workspace,
        requireApiKey: true,
      });
      try {
        const created = await app.inject({
          method: "POST",
          url: "/tasks",
          payload: { title: "无 key 任务", goal: "应停在 queued" },
        });
        assert.equal(created.statusCode, 201, "无 key 时仍允许创建任务");

        const tick = await scheduler.tick();
        assert.deepEqual(tick, { started: false, reason: "no-key" });
        assert.equal(provider.calls.length, 0, "no-key tick 不得调用 provider");

        const listed = await app.inject({ method: "GET", url: "/tasks" });
        const tasks = listed.json() as Array<{ status: string }>;
        assert.equal(tasks.length, 1);
        assert.equal(tasks[0]?.status, "queued", "任务必须停在 queued");

        const chat = await app.inject({
          method: "POST",
          url: "/chat",
          payload: { message: "你好" },
        });
        assert.equal(chat.statusCode, 503);
        const chatBody = asRecord(chat.json(), "chat error");
        const chatError = asRecord(chatBody.error, "chat error body");
        assert.equal(chatError.code, ERROR_CODES.E_PROVIDER_AUTH);
        const message = String(chatError.message);
        assert.ok(message.includes("未配置 API Key"), `错误应含中文指引：${message}`);
        assert.ok(message.includes("设置"), "错误应指引去设置");
        assert.ok(!chat.body.includes(TEST_KEY), "503 错误不得含 key");
      } finally {
        await scheduler.shutdown({ abort: true });
        await app.close();
      }
    });
  });
  rmSync(workspace, { recursive: true, force: true });
});

// ════════════════════════════════════════════════════════════════
// 4. 不重启生效：同一个 app 先 503，PUT key 后对话立即可用
// ════════════════════════════════════════════════════════════════

test("M12-01 即时生效：同一 app 内 PUT key 后 POST /chat 立即走 provider", async () => {
  const workspace = tempDir("task-terminal-m12-live-ws-");
  await withDb(async (db) => {
    await withoutEnvKey(async () => {
      const provider = new FakeProvider([{ content: "已连接，马上开始。" }]);
      const app = createApp({
        db,
        scheduler: stubScheduler(),
        mainAi: { provider },
        defaultWorkspace: workspace,
        requireApiKey: true,
      });
      try {
        const before = await app.inject({
          method: "POST",
          url: "/chat",
          payload: { message: "在吗" },
        });
        assert.equal(before.statusCode, 503);
        assert.equal(provider.calls.length, 0);

        const saved = await app.inject({
          method: "PUT",
          url: "/settings",
          payload: { apiKey: TEST_KEY },
        });
        assert.equal(saved.statusCode, 200);

        const after = await app.inject({
          method: "POST",
          url: "/chat",
          payload: { message: "现在呢" },
        });
        assert.equal(after.statusCode, 200, "PUT key 后无需重启即可对话");
        assert.match(after.body, /event: done/u);
        assert.ok(after.body.includes("已连接，马上开始。"));
        assert.equal(provider.calls.length, 1, "应真正调用注入的 provider");
      } finally {
        await app.close();
      }
    });
  });
  rmSync(workspace, { recursive: true, force: true });
});

// ════════════════════════════════════════════════════════════════
// 5. GET /settings/key-check：成功/失败两态，均不回 key
// ════════════════════════════════════════════════════════════════

test("M12-01 key-check：成功回余额、失败回脱敏原因，无 key 回中文指引", async () => {
  await withDb(async (db) => {
    await withoutEnvKey(async () => {
      let calls = 0;
      const successBalance: BalanceInfo = {
        isAvailable: true,
        balances: [
          {
            currency: "CNY",
            totalBalance: "12.34",
            grantedBalance: "0.00",
            toppedUpBalance: "12.34",
          },
        ],
      };
      const okApp = createApp({
        db,
        scheduler: stubScheduler(),
        mainAi: {
          provider: providerWithBalance(async () => {
            calls += 1;
            return successBalance;
          }),
        },
      });
      try {
        const noKey = await okApp.inject({ method: "GET", url: "/settings/key-check" });
        assert.equal(noKey.statusCode, 200);
        const noKeyBody = asRecord(noKey.json(), "key-check no key");
        assert.equal(noKeyBody.ok, false);
        assert.ok(String(noKeyBody.reason).includes("未配置 API Key"));
        assert.equal(calls, 0, "无 key 不应调用 checkBalance");

        saveSettings(db, { apiKey: TEST_KEY }, 2_000);
        const ok = await okApp.inject({ method: "GET", url: "/settings/key-check" });
        assert.equal(ok.statusCode, 200);
        assert.ok(!ok.body.includes(TEST_KEY), "key-check 响应不得含 key");
        const okBody = asRecord(ok.json(), "key-check ok");
        assert.equal(okBody.ok, true);
        assert.deepEqual(okBody.balance, successBalance);
        assert.equal(calls, 1);
      } finally {
        await okApp.close();
      }

      const failApp = createApp({
        db,
        scheduler: stubScheduler(),
        mainAi: {
          provider: providerWithBalance(async () => {
            throw new ContractError(
              ERROR_CODES.E_PROVIDER_AUTH,
              `mock 401：key=${TEST_KEY}`,
            );
          }),
        },
      });
      try {
        const failed = await failApp.inject({ method: "GET", url: "/settings/key-check" });
        assert.equal(failed.statusCode, 200);
        assert.ok(!failed.body.includes(TEST_KEY), "失败原因也必须脱敏 key");
        const failedBody = asRecord(failed.json(), "key-check failed");
        assert.equal(failedBody.ok, false);
        const reason = String(failedBody.reason);
        assert.ok(reason.includes("401"), `应透出可诊断原因：${reason}`);
        assert.ok(reason.includes("[REDACTED]"), "key 应被替换为 [REDACTED]");
      } finally {
        await failApp.close();
      }
    });
  });
});

// ════════════════════════════════════════════════════════════════
// 6. DeepSeekProvider 解析函数：每次请求重新取 key，空 key 报 AUTH
// ════════════════════════════════════════════════════════════════

test("M12-01 provider：apiKey 接受解析函数，每次请求用当前 key；空 key → E_PROVIDER_AUTH", async () => {
  const authorizations: string[] = [];
  const server = createServer((request, response) => {
    authorizations.push(String(request.headers.authorization ?? ""));
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  let current = TEST_KEY;
  try {
    const provider = new DeepSeekProvider({
      apiKey: () => current,
      baseUrl: `http://127.0.0.1:${port}`,
      retry: { maxRetries: 0, baseDelayMs: 1 },
    });
    const params: ChatParams = { messages: [{ role: "user", content: "hi" }] };
    await provider.chat(params);
    current = "sk-test-87654321";
    await provider.chat(params);

    assert.equal(authorizations[0], `Bearer ${TEST_KEY}`);
    assert.equal(authorizations[1], "Bearer sk-test-87654321");

    current = "";
    await assert.rejects(
      () => provider.chat(params),
      (error: unknown) =>
        error instanceof ContractError &&
        error.code === ERROR_CODES.E_PROVIDER_AUTH &&
        error.message.includes("未配置 API Key"),
      "空 key 必须报 E_PROVIDER_AUTH 与中文指引",
    );
    assert.equal(authorizations.length, 2, "空 key 不应发出网络请求");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
  }
});

// ════════════════════════════════════════════════════════════════
// 7. 主对话滚动摘要继承（M12-02）
// ════════════════════════════════════════════════════════════════

test("M12-02 滚动摘要：20 轮历史触发压缩、purpose=summary 落库、下一轮注入摘要块", async () => {
  await withDb(async (db) => {
    seedMainTurns(db, 20);
    const summaryText = "1. 用户偏好简洁。\n2. 关键结论：历史任务已派发。";
    const provider = new FakeProvider([
      { content: summaryText }, // 首轮开头的摘要调用
      { content: "第一轮回复" },
      { content: summaryText }, // 下一轮开头追平 turn 9 的摘要调用
      { content: "第二轮回复" },
    ]);

    const first = await runMainTurn({
      db,
      provider,
      userMessage: "第21轮问题",
      now: () => 5_000,
    });
    assert.equal(first.reply, "第一轮回复");
    await waitFor(
      () => getSettings(db).mainConversationSummary?.upToSeq === 16,
      "首轮摘要落库",
    );
    // 等单飞 promise 的 finally 清空，确保下一轮会真正再触发一次摘要。
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const summary = getSettings(db).mainConversationSummary;
    assert.ok(summary !== null, "超过 12 轮必须生成摘要");
    assert.equal(summary.upToSeq, 16, "20 轮省略前 8 轮，边界应是第 8 轮 assistant 的 seq");
    assert.equal(summary.updatedAt, 5_000, "updatedAt 应使用注入时钟");
    assert.ok(summary.text.includes("简洁"), "摘要应保留用户偏好");

    const rows = summaryRows(db);
    assert.equal(rows.length, 1, "应恰好有一条 purpose='summary' 记账");
    assert.equal(rows[0]?.purpose, "summary");
    assert.equal(rows[0]?.model, "deepseek-chat", "摘要应使用 settings.main.model");

    // 首轮 prompt 还没有摘要（摘要异步生成），但 12 轮窗口必须全文保留。
    assert.equal(provider.calls.length, 2, "一次摘要 + 一次主线调用");
    const firstPrompt = promptOf(provider.calls[1]);
    assert.match(firstPrompt, /\[已省略 8 轮更早对话\]/u);
    assert.ok(firstPrompt.includes("第9轮用户原文"), "最近 12 轮的第一轮应全文保留");
    assert.ok(firstPrompt.includes("第20轮助手原文"), "窗口最后一条也应保留");
    assert.ok(!firstPrompt.includes("原始第2轮问题"), "窗口外旧轮不应再全文进入 prompt");

    // 下一轮：摘要块 + 最近 12 轮全文；压缩 lag 的 turn 9 用省略标记兜底。
    const second = await runMainTurn({
      db,
      provider,
      userMessage: "第22轮问题",
      now: () => 5_001,
    });
    assert.equal(second.reply, "第二轮回复");
    await waitFor(
      () => getSettings(db).mainConversationSummary?.upToSeq === 18,
      "第二轮摘要追平 turn 9",
    );
    assert.equal(provider.calls.length, 4, "第二轮同样是一次摘要 + 一次主线调用");

    const secondSummaryPrompt = promptOf(provider.calls[2]);
    assert.ok(
      secondSummaryPrompt.includes("第9轮用户原文"),
      "第二轮摘要应只新增 turn 9",
    );
    assert.ok(secondSummaryPrompt.includes("用户偏好简洁"), "应把旧摘要一起带上");

    const secondPrompt = promptOf(provider.calls[3]);
    assert.match(secondPrompt, /## 对话记忆（早期摘要，截至第 8 轮）/u);
    assert.ok(secondPrompt.includes("简洁"), "摘要文本必须进入下一轮 prompt");
    assert.ok(secondPrompt.includes("第10轮用户原文"), "最近 12 轮仍应全文");
    assert.ok(secondPrompt.includes("第20轮助手原文"), "窗口最后一条仍应全文");
    assert.ok(secondPrompt.includes("第一轮回复"), "本轮之前刚完成的回答也应全文");
    assert.ok(!secondPrompt.includes("原始第2轮问题"), "第 2 轮原文应已被摘要替代");
    assert.match(secondPrompt, /\[已省略 1 轮更早对话\]/u, "lag 的 1 轮应保留省略标记");
  });
});

test("M12-02 有摘要的上下文：摘要块在长期事实之后、12 轮全文、旧轮不再全文", async () => {
  await withDb((db) => {
    seedMainTurns(db, 20);
    upsertFact(db, {
      key: "user.tone",
      value: "简洁",
      confidence: 0.9,
      now: 1_000,
    });
    const summary = {
      text: "- 用户偏好：简洁\n- 关键结论：保持 12 轮全文",
      upToSeq: 16,
      updatedAt: 1_234,
    };
    saveSettings(db, { mainConversationSummary: summary }, 1_234);

    const gathered = gatherMainContext(db, { userMessage: "继续" });
    assert.equal(gathered.omittedHistoryTurns, 0, "摘要已覆盖窗口外旧轮，无省略标记");
    assert.equal(gathered.history.length, 24, "窗口仍是最近 12 轮 = 24 条");
    assert.equal(gathered.history[0]?.content, "第9轮用户原文：用户内容 9");
    assert.equal(
      gathered.history[gathered.history.length - 1]?.content,
      "第20轮助手原文：助手内容 20",
    );

    const messages = buildMainContext(db, { ...gathered, systemPrompt: "SYS" });
    const prompt = messages.map((message) => llmContentText(message.content)).join("\n");
    assert.equal(
      formatSummaryBlock(summary),
      "## 对话记忆（早期摘要，截至第 8 轮）\n- 用户偏好：简洁\n- 关键结论：保持 12 轮全文",
    );
    const factAt = prompt.indexOf("## 长期事实");
    const summaryAt = prompt.indexOf("## 对话记忆（早期摘要，截至第 8 轮）");
    assert.ok(factAt >= 0 && summaryAt > factAt, "摘要块必须放在长期事实之后");
    assert.ok(prompt.includes(summary.text), "缺少摘要正文");
    assert.ok(prompt.includes("第9轮用户原文"), "窗口内第 9 轮必须全文");
    assert.ok(prompt.includes("第10轮助手原文"), "窗口内第 10 轮必须全文");
    assert.ok(prompt.includes("第20轮助手原文"), "窗口最后一条必须全文");
    assert.ok(!prompt.includes("原始第2轮问题"), "已摘要的第 2 轮不应再全文出现");
    assert.ok(!prompt.includes("[已省略"), "无 lag 时不应再出现省略标记");
  });
});

test("M12-02 摘要失败：WARN 不静默、settings 不变、下一轮回退省略标记", async () => {
  await withDb(async (db) => {
    seedMainTurns(db, 13);
    const provider = new FakeProvider([
      { error: new Error("mock summary 失败") },
      { content: "主回复继续" },
    ]);

    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.map((value) => String(value)).join(" "));
    };
    try {
      const result = await runMainTurn({
        db,
        provider,
        userMessage: "触发摘要失败",
        now: () => 7_000,
      });
      assert.equal(result.reply, "主回复继续", "摘要失败不得影响本轮主线回复");
      await waitFor(() => warnings.length > 0, "摘要失败 WARN");
    } finally {
      console.warn = originalWarn;
    }

    assert.ok(
      warnings.some((line) => line.includes("滚动摘要生成失败")),
      `失败必须记 WARN，实际：${warnings.join("\n")}`,
    );
    assert.equal(
      getSettings(db).mainConversationSummary,
      null,
      "失败不得写入半成品摘要",
    );
    const rows = summaryRows(db);
    assert.equal(rows.length, 1, "失败调用也应记账");
    assert.equal(rows[0]?.input_tokens, 0, "失败的 usage 记 0");

    // 下一轮 prompt：没有摘要块，回退旧的省略标记（窗口外 2 轮未摘要）。
    const gathered = gatherMainContext(db, { userMessage: "下一轮" });
    assert.equal(gathered.summary, null);
    const prompt = buildMainContext(db, {
      ...gathered,
      systemPrompt: "SYS",
    })
      .map((message) => llmContentText(message.content))
      .join("\n");
    assert.ok(!prompt.includes("## 对话记忆"), "失败后不得注入空摘要");
    assert.match(prompt, /\[已省略 2 轮更早对话\]/u);
    assert.ok(!prompt.includes("原始第2轮问题"), "旧轮仍应被省略");
  });
});

test("M12-02 不足/恰好 12 轮：不触发摘要调用，窗口内始终全文", async () => {
  await withDb(async (db) => {
    seedMainTurns(db, 11);
    const provider = new FakeProvider([
      { content: "第一轮回复" },
      { content: "第二轮回复" },
    ]);

    // 第 1 轮前 11 轮、第 2 轮前恰好 12 轮：都不应触发摘要。
    await runMainTurn({ db, provider, userMessage: "第12轮问题" });
    await runMainTurn({ db, provider, userMessage: "第13轮问题" });

    assert.equal(provider.calls.length, 2, "只有两次主线调用，没有摘要调用");
    assert.equal(
      getSettings(db).mainConversationSummary,
      null,
      "12 轮内不得生成摘要",
    );
    assert.equal(summaryRows(db).length, 0, "不得出现 purpose='summary' 行");

    const gathered = gatherMainContext(db, { userMessage: "第13轮问题" });
    assert.equal(gathered.omittedHistoryTurns, 1, "13 轮只省略窗口外的第 1 轮");
    assert.equal(gathered.history.length, 24, "窗口恰好 12 轮 = 24 条");
    const prompt = buildMainContext(db, {
      ...gathered,
      systemPrompt: "SYS",
    })
      .map((message) => llmContentText(message.content))
      .join("\n");
    assert.ok(prompt.includes("原始第2轮问题"), "窗口内旧轮必须全文");
    assert.ok(prompt.includes("第一轮回复"), "窗口内刚完成的轮次必须全文");
    assert.ok(prompt.includes("第二轮回复"), "窗口最后一条必须全文");
    assert.match(prompt, /\[已省略 1 轮更早对话\]/u);
    assert.ok(!prompt.includes("## 对话记忆"), "无摘要时维持现状");
  });
});

test("M12-02 maybeCompactSummary：可单独调用，不足窗口时 no-op 不调 provider", async () => {
  await withDb(async (db) => {
    seedMainTurns(db, 12);
    const provider = new FakeProvider([]);
    const result = await maybeCompactSummary(db, provider, { now: () => 1_000 });
    assert.equal(result, null);
    assert.equal(provider.calls.length, 0, "12 轮内应为 no-op");
    assert.equal(getSettings(db).mainConversationSummary, null);
  });
});
