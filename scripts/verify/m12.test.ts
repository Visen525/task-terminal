import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { ContractError, ERROR_CODES } from "../../src/core/errors.ts";
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
import { openDatabase } from "../../src/store/migrate.ts";
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
