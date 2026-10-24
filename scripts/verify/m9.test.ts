import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { runMainTurn } from "../../src/agent/main-loop.ts";
import { ContractError, ERROR_CODES } from "../../src/core/errors.ts";
import type { LlmContentPart, LlmMessage } from "../../src/core/types.ts";
import { FakeProvider, type FakeStep } from "../../src/providers/fake.ts";
import { estimateTokenUsage } from "../../src/providers/types.ts";
import { DEFAULT_DAILY_BUDGET_TOKENS, getLocalDayRange } from "../../src/runtime/watchdog.ts";
import type { Scheduler } from "../../src/runtime/scheduler.ts";
import { createApp } from "../../src/server/index.ts";
import { insertArtifact } from "../../src/store/artifacts.ts";
import { upsertFact } from "../../src/store/facts.ts";
import { insertLlmCall } from "../../src/store/llm-calls.ts";
import { appendMessage, listRecentMessages } from "../../src/store/messages.ts";
import { openDatabase } from "../../src/store/migrate.ts";
import { insertTask } from "../../src/store/repo.ts";

const root = join(import.meta.dirname, "..", "..");
const workspace = join(tmpdir(), "task-terminal-m9-ws");

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  assert.ok(isRecord(value), `预期 ${label} 是对象，实际 ${String(value)}`);
  return value;
}

function asArray(value: unknown, label: string): unknown[] {
  assert.ok(Array.isArray(value), `预期 ${label} 是数组，实际 ${String(value)}`);
  return value;
}

function stubScheduler(): Scheduler {
  return {
    tick: async () => ({ started: false, reason: "empty" }),
    runAll: async () => [],
    shutdown: async () => undefined,
    cancel: () => false,
  };
}

async function withApp(
  clock: () => number,
  fn: (context: { db: DatabaseSync; app: ReturnType<typeof createApp> }) => Promise<void>,
): Promise<void> {
  const db = openDatabase(":memory:");
  const app = createApp({
    db,
    scheduler: stubScheduler(),
    defaultWorkspace: workspace,
    now: clock,
  });
  try {
    await fn({ db, app });
  } finally {
    await app.close();
    db.close();
  }
}

test("M9-02 GET /facts：默认只返回当前有效版本，includeSuperseded 返回完整链条并按 scope/key 排序", async () => {
  await withApp(
    () => 0,
    async ({ db, app }) => {
      const task = insertTask(db, { title: "记忆来源", goal: "测试", workspace });
      const first = upsertFact(db, {
        key: "偏好语言",
        value: "TypeScript",
        scope: "global",
        confidence: 0.4,
        sourceTaskId: task.id,
        now: 1_000,
      });
      const second = upsertFact(db, {
        key: "偏好语言",
        value: "Rust",
        scope: "global",
        confidence: 0.9,
        sourceTaskId: task.id,
        now: 2_000,
      });
      const projectFact = upsertFact(db, {
        key: "构建命令",
        value: "pnpm verify",
        scope: "project:demo",
        confidence: 0.7,
        now: 3_000,
      });

      const currentResponse = await app.inject({ method: "GET", url: "/facts" });
      assert.equal(currentResponse.statusCode, 200);
      const current = asArray(currentResponse.json(), "GET /facts").map((row) =>
        asRecord(row, "fact"),
      );
      assert.deepEqual(
        current.map((row) => row.key),
        ["偏好语言", "构建命令"],
        "预期只含两条当前有效事实，并按 scope 排序（global 在 project:demo 前）",
      );
      const currentSecond = current[0];
      assert.ok(currentSecond !== undefined);
      for (const field of [
        "id",
        "key",
        "value",
        "confidence",
        "scope",
        "source_task_id",
        "created_at",
        "updated_at",
        "superseded_by",
      ]) {
        assert.ok(field in currentSecond, `预期列表项包含字段 ${field}`);
      }
      assert.equal(currentSecond.value, "Rust");
      assert.equal(currentSecond.superseded_by, null);
      assert.equal(currentSecond.source_task_id, task.id);
      assert.equal(currentSecond.confidence, 0.9);
      assert.equal(
        current.some((row) => row.id === first.id),
        false,
        "预期默认列表不包含已被取代的旧版本",
      );

      const allResponse = await app.inject({
        method: "GET",
        url: "/facts?includeSuperseded=true",
      });
      assert.equal(allResponse.statusCode, 200);
      const all = asArray(allResponse.json(), "GET /facts?includeSuperseded=true").map((row) =>
        asRecord(row, "fact"),
      );
      assert.equal(all.length, 3, "预期包含两条版本与一条其他 scope 事实");
      const oldVersion = all.find((row) => row.id === first.id);
      assert.ok(oldVersion !== undefined, "预期历史列表包含旧版本");
      assert.equal(oldVersion.superseded_by, second.id, "预期旧版本指向新版本");
      assert.equal(oldVersion.value, "TypeScript");

      const emptyValue = await app.inject({
        method: "GET",
        url: "/facts?includeSuperseded=",
      });
      assert.equal(emptyValue.statusCode, 200);
      assert.equal(
        asArray(emptyValue.json(), "GET /facts?includeSuperseded=").length,
        3,
        "预期空值 includeSuperseded 视为 true",
      );

      const invalid = await app.inject({
        method: "GET",
        url: "/facts?includeSuperseded=maybe",
      });
      assert.equal(invalid.statusCode, 400, "预期非法布尔参数返回 400");

      const projectRows = all.filter((row) => row.id === projectFact.id);
      assert.equal(projectRows.length, 1, "预期项目事实也在历史列表中");
    },
  );
});

test("M9-02 DELETE /facts/:id：删除当前版本并清理悬挂 superseded_by，重复删除 404，非法 id 400", async () => {
  await withApp(
    () => 0,
    async ({ db, app }) => {
      const first = upsertFact(db, {
        key: "编辑器",
        value: "VS Code",
        scope: "global",
        now: 1_000,
      });
      const second = upsertFact(db, {
        key: "编辑器",
        value: "Neovim",
        scope: "global",
        now: 2_000,
      });

      const eventCountBefore = Number(
        (
          db.prepare("SELECT COUNT(*) AS count FROM events").get() as unknown as {
            count: number | bigint;
          }
        ).count,
      );

      const beforeDelete = await app.inject({
        method: "GET",
        url: "/facts?includeSuperseded=true",
      });
      const beforeRows = asArray(beforeDelete.json(), "facts before delete").map((row) =>
        asRecord(row, "fact"),
      );
      const oldBefore = beforeRows.find((row) => row.id === first.id);
      assert.ok(oldBefore !== undefined);
      assert.equal(oldBefore.superseded_by, second.id);

      const deleted = await app.inject({
        method: "DELETE",
        url: `/facts/${second.id}`,
      });
      assert.equal(deleted.statusCode, 200);
      assert.deepEqual(deleted.json(), { deleted: 1 });

      const eventCountAfter = Number(
        (
          db.prepare("SELECT COUNT(*) AS count FROM events").get() as unknown as {
            count: number | bigint;
          }
        ).count,
      );
      assert.equal(
        eventCountAfter,
        eventCountBefore,
        "预期事实硬删除不写事件（EVENT_TYPES 无对应类型）",
      );

      const afterDelete = await app.inject({
        method: "GET",
        url: "/facts?includeSuperseded=true",
      });
      const afterRows = asArray(afterDelete.json(), "facts after delete").map((row) =>
        asRecord(row, "fact"),
      );
      assert.equal(
        afterRows.some((row) => row.id === second.id),
        false,
        "预期被删除的事实不再出现",
      );
      const restored = afterRows.find((row) => row.id === first.id);
      assert.ok(restored !== undefined, "预期上一版本仍存在");
      assert.equal(
        restored.superseded_by,
        null,
        "预期指向被删行的 superseded_by 被清空，旧版本重新成为当前有效记录",
      );

      const current = await app.inject({ method: "GET", url: "/facts" });
      const currentRows = asArray(current.json(), "facts current").map((row) =>
        asRecord(row, "fact"),
      );
      assert.deepEqual(
        currentRows.map((row) => row.id),
        [first.id],
        "预期删除清链后当前有效记录只剩上一版",
      );

      const again = await app.inject({
        method: "DELETE",
        url: `/facts/${second.id}`,
      });
      assert.equal(again.statusCode, 404, "预期同一 id 再次删除返回 404");

      const missing = await app.inject({
        method: "DELETE",
        url: `/facts/f_${"0".repeat(26)}`,
      });
      assert.equal(missing.statusCode, 404, "预期格式合法但不存在的事实返回 404");

      const malformed = await app.inject({
        method: "DELETE",
        url: "/facts/not-a-fact-id",
      });
      assert.equal(malformed.statusCode, 400, "预期非法 id 返回 400");
      const malformedBody = asRecord(malformed.json(), "invalid id body");
      const error = asRecord(malformedBody.error, "invalid id error");
      assert.equal(
        typeof error.message === "string" && error.message.includes("not-a-fact-id"),
        false,
        "预期错误信息不回显用户输入",
      );
    },
  );
});

test("M9-02 GET /settings/overview：模型、日预算、今日四数字与三张 COUNT 正确", async () => {
  const now = new Date(2026, 9, 24, 12, 0, 0, 0).getTime();
  const { startMs } = getLocalDayRange(now);

  await withApp(
    () => now,
    async ({ db, app }) => {
      const task = insertTask(db, {
        title: "统计来源",
        goal: "测试",
        workspace,
        now,
      });
      insertArtifact(db, {
        taskId: task.id,
        kind: "note",
        title: "统计产物",
        summary: "用于验证 overview 的产物计数。",
        now,
      });
      upsertFact(db, { key: "统计事实", value: "旧值", scope: "global", now: now - 2_000 });
      upsertFact(db, { key: "统计事实", value: "新值", scope: "global", now: now - 1_000 });

      insertLlmCall(db, {
        purpose: "main",
        model: "deepseek-chat",
        inputTokens: 100,
        cachedTokens: 40,
        outputTokens: 20,
        ts: now,
      });
      insertLlmCall(db, {
        purpose: "agent",
        model: "deepseek-chat",
        inputTokens: 50,
        cachedTokens: 0,
        outputTokens: 10,
        ts: startMs + 1_000,
      });
      insertLlmCall(db, {
        purpose: "main",
        model: "deepseek-chat",
        inputTokens: 999,
        cachedTokens: 0,
        outputTokens: 999,
        ts: startMs - 1,
      });

      const response = await app.inject({ method: "GET", url: "/settings/overview" });
      assert.equal(response.statusCode, 200);
      const body = asRecord(response.json(), "overview");
      assert.equal(body.model, "deepseek-chat");
      assert.equal(body.dailyBudgetTokens, DEFAULT_DAILY_BUDGET_TOKENS);

      const usage = asRecord(body.todayUsage, "overview.todayUsage");
      assert.equal(usage.input, 150, "预期只累计今日 input_tokens");
      assert.equal(usage.cached, 40, "预期只累计今日 cached_tokens");
      assert.equal(usage.output, 30, "预期只累计今日 output_tokens");
      assert.equal(usage.total, 180, "预期 total = input + output（cached 不重复计入）");

      const counts = asRecord(body.counts, "overview.counts");
      assert.deepEqual(counts, { tasks: 1, artifacts: 1, facts: 2 });
    },
  );
});

test("M9-02 前端接线：Settings 页面存在，App 齿轮打开设置，API 路径与 Vite 代理就位", () => {
  assert.ok(existsSync(join(root, "src/web/src/pages/Settings.tsx")), "预期 Settings.tsx 存在");

  const app = read("src/web/src/App.tsx");
  assert.ok(app.includes('import Settings from "./pages/Settings"'), "预期 App 导入 Settings");
  assert.ok(app.includes("<Settings onOpenTask={openTask} />"), "预期 App 渲染 Settings");
  assert.ok(app.includes('setActiveKey("settings")'), "预期齿轮点击后切到设置视图");
  assert.ok(app.includes('activeKey === "settings"'), "预期设置视图纳入极简路由");
  assert.ok(app.includes('aria-label="设置"'), "预期齿轮有可访问名称");

  const settings = read("src/web/src/pages/Settings.tsx");
  for (const marker of [
    "/settings/overview",
    "/facts?",
    "DELETE",
    "Popconfirm",
    "Switch",
    "Progress",
    "显示被取代的历史版本",
    "主 AI 还没有记住任何事。",
    "记住…",
  ]) {
    assert.ok(settings.includes(marker), `预期 Settings.tsx 包含 ${marker}`);
  }

  const vite = read("src/web/vite.config.ts");
  for (const route of ["/facts", "/settings"]) {
    assert.ok(vite.includes(`"${route}"`), `预期 Vite 代理包含 ${route}`);
  }
});

test("M9-02 脚本与依赖：verify 注册 m9，package.json 依赖零新增", () => {
  const pkg: unknown = JSON.parse(read("package.json"));
  const packageJson = asRecord(pkg, "package.json");
  const scripts = asRecord(packageJson.scripts, "package.json scripts");
  const verify = scripts.verify;
  assert.equal(typeof verify, "string");
  assert.ok(
    (verify as string).includes("scripts/verify/m9.test.ts"),
    "预期总 verify 追加 m9.test.ts",
  );
  assert.equal(
    scripts["verify:m9"],
    "node --test --test-isolation=none scripts/verify/m9.test.ts",
  );

  const dependencies = asRecord(packageJson.dependencies, "dependencies");
  const devDependencies = asRecord(packageJson.devDependencies, "devDependencies");
  assert.deepEqual(
    Object.keys(dependencies).sort(),
    [
      "@ant-design/icons",
      "@tanstack/react-query",
      "@tanstack/react-virtual",
      "antd",
      "fastify",
      "react",
      "react-dom",
      "react-markdown",
    ].sort(),
  );
  assert.deepEqual(
    Object.keys(devDependencies).sort(),
    [
      "@types/node",
      "@types/react",
      "@types/react-dom",
      "@vitejs/plugin-react",
      "prettier",
      "typescript",
      "vite",
    ].sort(),
  );
});

// ── M9-03 对话附件与引用 ────────────────────────────────────────

const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function attachmentOf(name: string, mime: string, bytes: Buffer) {
  return { name, mime, dataBase64: bytes.toString("base64") };
}

function textAttachment(name: string, mime: string, text: string) {
  return attachmentOf(name, mime, Buffer.from(text, "utf8"));
}

function listUploadFiles(uploadsDir: string): string[] {
  return existsSync(uploadsDir) ? readdirSync(uploadsDir) : [];
}

async function postChat(baseUrl: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify(body),
  });
}

async function getChatMessages(
  baseUrl: string,
): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`${baseUrl}/messages?limit=50`);
  assert.equal(response.status, 200, "预期 GET /messages 返回 200");
  const body: unknown = await response.json();
  return asArray(body, "GET /messages").map((row) => asRecord(row, "message"));
}

function textPartOf(content: LlmMessage["content"]): string {
  assert.ok(Array.isArray(content), "预期 content 是多模态分片数组");
  const parts = content as readonly LlmContentPart[];
  const text = parts.find(
    (part): part is Extract<LlmContentPart, { type: "text" }> =>
      part.type === "text",
  );
  assert.ok(text !== undefined, "预期分片里存在 text 部分");
  return text.text;
}

function imagePartsOf(content: LlmMessage["content"]): string[] {
  assert.ok(Array.isArray(content), "预期 content 是多模态分片数组");
  return (content as readonly LlmContentPart[])
    .filter(
      (part): part is Extract<LlmContentPart, { type: "image_url" }> =>
        part.type === "image_url",
    )
    .map((part) => part.image_url.url);
}

async function withChatApp(
  script: FakeStep[],
  fn: (context: {
    base: string;
    db: DatabaseSync;
    app: ReturnType<typeof createApp>;
    baseUrl: string;
    uploadsDir: string;
    provider: FakeProvider;
  }) => Promise<void>,
): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), "task-terminal-m9-chat-"));
  const uploadsDir = join(base, "uploads");
  const db = openDatabase(":memory:");
  const provider = new FakeProvider(script);
  const app = createApp({
    db,
    scheduler: stubScheduler(),
    defaultWorkspace: workspace,
    mainAi: { provider },
    uploadsDir,
    now: () => 1_000,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(
    address !== null && typeof address === "object",
    "预期测试服务器返回端口",
  );
  const baseUrl = `http://127.0.0.1:${String(address.port)}`;
  try {
    await fn({ base, db, app, baseUrl, uploadsDir, provider });
  } finally {
    await app.close();
    db.close();
    rmSync(base, { recursive: true, force: true });
  }
}

test(
  "M9-03 POST /chat 附件：图片 data URL 分片 + 文本内联 + attachments 元数据落库 + GET /messages 纯文本",
  { timeout: 30_000 },
  async () => {
    await withChatApp(
      [{ content: "收到图片和文件" }],
      async ({ baseUrl, db, uploadsDir, provider }) => {
        const textBytes = Buffer.from("# 笔记\n这是附件里的文字", "utf8");
        const response = await postChat(baseUrl, {
          message: "请看图并读文件",
          attachments: [
            { name: "red.png", mime: "image/png", dataBase64: PNG_1X1_BASE64 },
            attachmentOf("notes.md", "text/markdown", textBytes),
          ],
        });
        assert.equal(response.status, 200, "预期带附件对话建立 SSE 流");
        const sse = await response.text();
        assert.ok(sse.includes("event: done"), "预期流正常结束于 done");

        const firstCallMessages = provider.calls[0]?.messages ?? [];
        const currentUser = firstCallMessages.at(-1);
        assert.equal(currentUser?.role, "user");
        const text = textPartOf(currentUser?.content ?? []);
        assert.ok(text.includes("请看图并读文件"), "预期文本部分保留用户消息");
        assert.ok(
          text.includes("【附件 notes.md】\n# 笔记\n这是附件里的文字"),
          `预期文本附件内联到文本部分，实际 ${text}`,
        );
        assert.deepEqual(
          imagePartsOf(currentUser?.content ?? []),
          [`data:image/png;base64,${PNG_1X1_BASE64}`],
          "预期图片以 data URL 进入 image_url 分片",
        );

        const rows = await getChatMessages(baseUrl);
        const userRow = rows.find((row) => row.role === "user");
        assert.ok(userRow !== undefined, "预期历史含 user 消息");
        assert.equal(userRow.text, "请看图并读文件", "预期 text 只保留用户输入");
        assert.equal(
          userRow.content,
          "请看图并读文件",
          "预期保留 content 兼容字段且与 text 相同",
        );
        const metadata = asArray(userRow.attachments, "user.attachments").map(
          (item) => asRecord(item, "attachment"),
        );
        assert.equal(metadata.length, 2, "预期两个附件元数据");
        const imageMeta = metadata.find((item) => item.name === "red.png");
        const fileMeta = metadata.find((item) => item.name === "notes.md");
        assert.ok(imageMeta !== undefined && fileMeta !== undefined);
        assert.equal(imageMeta.mime, "image/png");
        assert.equal(imageMeta.size, Buffer.from(PNG_1X1_BASE64, "base64").length);
        assert.match(String(imageMeta.path), /^data\/uploads\//u);
        assert.equal(typeof imageMeta.id, "string");
        assert.equal(readdirSync(uploadsDir).length, 2, "预期两个文件落盘");

        const stored = listRecentMessages(db, 10);
        assert.equal(stored[0]?.content, "请看图并读文件");
        assert.deepEqual(
          stored[0]?.attachments?.map((item) => item.name),
          ["red.png", "notes.md"],
        );

        const imageId = String(imageMeta.id);
        const imageResponse = await fetch(`${baseUrl}/uploads/${imageId}`);
        assert.equal(imageResponse.status, 200);
        assert.equal(imageResponse.headers.get("content-type"), "image/png");
        assert.equal(imageResponse.headers.get("content-disposition"), "inline");
        assert.equal(
          Buffer.from(await imageResponse.arrayBuffer()).toString("base64"),
          PNG_1X1_BASE64,
          "预期 GET /uploads 原样下发图片字节",
        );

        const prefixResponse = await fetch(
          `${baseUrl}/uploads/${imageId.slice(0, 10)}`,
        );
        assert.equal(prefixResponse.status, 200, "预期按 ULID 前缀也能定位");

        // 附件正文只进当前轮 provider content，不写进 messages.content。
        assert.equal(
          stored[0]?.content.includes("这是附件里的文字"),
          false,
          "预期落库文本不含附件正文",
        );
      },
    );
  },
);

test(
  "M9-03 POST /chat：文本附件超 64KB 截断注明，二进制附件只注明元信息",
  { timeout: 30_000 },
  async () => {
    await withChatApp(
      [{ content: "已处理" }],
      async ({ baseUrl, provider }) => {
        const big = "A".repeat(64 * 1024 + 32);
        const response = await postChat(baseUrl, {
          message: "处理这些附件",
          attachments: [
            textAttachment("big.txt", "text/plain", big),
            attachmentOf("data.bin", "application/octet-stream", Buffer.from("bin")),
            textAttachment("script.ps1", "application/octet-stream", "Write-Host hi"),
          ],
        });
        assert.equal(response.status, 200);
        await response.text();

        const current = provider.calls[0]?.messages.at(-1);
        const text = textPartOf(current?.content ?? []);
        assert.ok(text.includes("【附件 big.txt】\nAAAA"), "预期超长文本仍内联前缀");
        assert.ok(text.includes("内容超过 64KB，已截断"), "预期截断有明确注明");
        assert.equal(
          text.includes("A".repeat(64 * 1024 + 1)),
          false,
          "预期超过 64KB 的部分不进入上下文",
        );
        assert.ok(
          text.includes(
            "已收到二进制附件 data.bin（3 B，已存档，模型无法直接读取）",
          ),
          `预期二进制附件只给元信息，实际 ${text}`,
        );
        assert.ok(
          text.includes("【附件 script.ps1】\nWrite-Host hi"),
          "预期扩展名可识别的文本文件（即使 mime 是 octet-stream）也内联",
        );
        assert.equal(
          imagePartsOf(current?.content ?? []).length,
          0,
          "预期没有图片分片",
        );
      },
    );
  },
);

test(
  "M9-03 POST /chat 附件限制：>5 个、单个 >8MB、总量 >16MB、非法 base64 均 400 且不落盘",
  { timeout: 60_000 },
  async () => {
    await withChatApp([{ content: "只允许一次有效请求" }], async ({ app, baseUrl, uploadsDir }) => {
      const errorCode = async (response: Response): Promise<unknown> => {
        assert.equal(response.status, 400, "预期附件违规返回 400");
        const body = asRecord(await response.json(), "error body");
        return asRecord(body.error, "error").code;
      };

      const six = await postChat(baseUrl, {
        message: "太多",
        attachments: Array.from({ length: 6 }, (_value, index) =>
          textAttachment(`f${String(index)}.txt`, "text/plain", "x"),
        ),
      });
      assert.equal(await errorCode(six), ERROR_CODES.E_INVALID_ARGUMENT);

      const tooLargeSingle = await postChat(baseUrl, {
        message: "单个太大",
        attachments: [
          attachmentOf(
            "big.bin",
            "application/octet-stream",
            Buffer.alloc(8 * 1024 * 1024 + 1),
          ),
        ],
      });
      assert.equal(await errorCode(tooLargeSingle), ERROR_CODES.E_INVALID_ARGUMENT);

      const tooLargeTotal = await postChat(baseUrl, {
        message: "总量太大",
        attachments: [
          attachmentOf("a.bin", "application/octet-stream", Buffer.alloc(8 * 1024 * 1024)),
          attachmentOf("b.bin", "application/octet-stream", Buffer.alloc(8 * 1024 * 1024)),
          attachmentOf("c.bin", "application/octet-stream", Buffer.from("x")),
        ],
      });
      assert.equal(await errorCode(tooLargeTotal), ERROR_CODES.E_INVALID_ARGUMENT);

      const badBase64 = await postChat(baseUrl, {
        message: "非法内容",
        attachments: [
          { name: "x.txt", mime: "text/plain", dataBase64: "!!!not-base64" },
        ],
      });
      assert.equal(await errorCode(badBase64), ERROR_CODES.E_INVALID_ARGUMENT);

      assert.deepEqual(
        listUploadFiles(uploadsDir),
        [],
        "预期所有违规请求都在写文件前被拒绝",
      );

      // 净化文件名：取 basename、去掉分隔符，且长度 ≤120 个码点。
      const longName = `${"长".repeat(130)}.txt`;
      const valid = await postChat(baseUrl, {
        message: "净化文件名",
        attachments: [
          textAttachment("..\\..\\evil/../../secret.txt", "text/plain", "secret"),
          textAttachment(longName, "text/plain", "long"),
        ],
      });
      assert.equal(valid.status, 200);
      await valid.text();
      const rows = (await app.inject({ method: "GET", url: "/messages?limit=5" })).json();
      const userRow = asArray(rows, "messages")
        .map((row) => asRecord(row, "message"))
        .find((row) => row.role === "user");
      assert.ok(userRow !== undefined);
      const names = asArray(userRow.attachments, "attachments")
        .map((item) => asRecord(item, "attachment").name)
        .map((name) => String(name));
      assert.equal(names[0], "secret.txt", "预期路径分隔符被剥离");
      assert.equal([...(names[1] ?? "")].length, 120, "预期文件名截到 120 个码点");
      for (const name of names) {
        assert.equal(name.includes("/"), false);
        assert.equal(name.includes("\\"), false);
      }
    });
  },
);

test(
  "M9-03 GET /uploads/:id：按存储 mime 内联下发；路径穿越/非法 id/不存在统一 404",
  { timeout: 30_000 },
  async () => {
    await withChatApp(
      [{ content: "ok" }],
      async ({ base, baseUrl }) => {
        const secretPath = join(base, "secret.txt");
        writeFileSync(secretPath, "TOP-SECRET", "utf8");
        const response = await postChat(baseUrl, {
          message: "附件",
          attachments: [
            { name: "dot.png", mime: "image/png", dataBase64: PNG_1X1_BASE64 },
            textAttachment("note.txt", "text/plain", "hello"),
            attachmentOf("raw.bin", "application/octet-stream", Buffer.from("raw")),
          ],
        });
        assert.equal(response.status, 200);
        await response.text();

        const rows = await getChatMessages(baseUrl);
        const user = rows.find((row) => row.role === "user");
        assert.ok(user !== undefined);
        const metadata = asArray(user.attachments, "attachments").map((row) =>
          asRecord(row, "attachment"),
        );
        const byName = new Map(metadata.map((item) => [String(item.name), item]));

        const textResponse = await fetch(
          `${baseUrl}/uploads/${String(byName.get("note.txt")?.id)}`,
        );
        assert.equal(textResponse.status, 200);
        assert.match(
          textResponse.headers.get("content-type") ?? "",
          /^text\/plain/u,
          "预期以 messages 中存储的 mime 下发",
        );
        assert.equal(
          await textResponse.text(),
          "hello",
          "预期下发上传时的原始字节",
        );

        const binaryResponse = await fetch(
          `${baseUrl}/uploads/${String(byName.get("raw.bin")?.id)}`,
        );
        assert.equal(binaryResponse.status, 200);
        assert.equal(
          binaryResponse.headers.get("content-type"),
          "application/octet-stream",
        );

        for (const url of [
          "/uploads/..%2F..%2Fsecret.txt",
          "/uploads/%2e%2e%2fsecret.txt",
          `/uploads/${encodeURIComponent("../secret.txt")}`,
          "/uploads/not-a-ulid",
          `/uploads/${"0".repeat(26)}`,
          "/uploads/%2e%2e%5cwindows%5cwin.ini",
        ]) {
          const missing = await fetch(`${baseUrl}${url}`);
          assert.equal(missing.status, 404, `预期 ${url} 返回 404`);
          const body = asRecord(await missing.json(), "404 body");
          assert.equal(
            asRecord(body.error, "404 error").code,
            ERROR_CODES.E_NOT_FOUND,
          );
        }
      },
    );
  },
);

test("M9-03 messages 读写兼容：旧版 JSON 字符串与新 {text,attachments} 都能读，GET /messages 给 text", async () => {
  await withApp(
    () => 1_000,
    async ({ db, app }) => {
      appendMessage(db, { role: "user", content: "旧格式消息", ts: 1 });
      appendMessage(db, {
        role: "user",
        content: "新格式消息",
        ts: 2,
        attachments: [
          {
            id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            name: "a.txt",
            mime: "text/plain",
            size: 3,
            path: "data/uploads/01ARZ3NDEKTSV4RRFFQ69G5FAV__a.txt",
          },
        ],
      });

      const rawRows = db
        .prepare("SELECT content FROM messages ORDER BY seq ASC")
        .all() as unknown as Array<{ content: string }>;
      assert.equal(
        JSON.parse(rawRows[0]?.content ?? "null"),
        "旧格式消息",
        "预期旧消息仍是 JSON 字符串",
      );
      const newRaw = asRecord(
        JSON.parse(rawRows[1]?.content ?? "null") as unknown,
        "new content",
      );
      assert.equal(newRaw.text, "新格式消息");
      assert.equal(
        asArray(newRaw.attachments, "new attachments").length,
        1,
        "预期新消息落库为 {text,attachments}",
      );

      const listed = listRecentMessages(db, 10);
      assert.deepEqual(
        listed.map((message) => message.content),
        ["旧格式消息", "新格式消息"],
      );
      assert.equal(listed[0]?.attachments, undefined);
      assert.equal(listed[1]?.attachments?.[0]?.name, "a.txt");

      const response = await app.inject({ method: "GET", url: "/messages" });
      assert.equal(response.statusCode, 200);
      const rows = asArray(response.json(), "GET /messages").map((row) =>
        asRecord(row, "message"),
      );
      assert.deepEqual(
        rows.map((row) => row.text),
        ["旧格式消息", "新格式消息"],
        "预期 v1.1 text 字段",
      );
      assert.deepEqual(
        rows.map((row) => row.content),
        ["旧格式消息", "新格式消息"],
        "预期旧 content 字段仍保留",
      );
      assert.equal(rows[0]?.attachments, undefined);
      assert.equal(
        asArray(rows[1]?.attachments, "attachments")[0] !== undefined,
        true,
      );
    },
  );
});

test(
  "M9-03 runMainTurn 多模态：当前轮分片原样进 provider，历史轮折纯文本；二选一冲突抛 E_INVALID_ARGUMENT",
  { timeout: 30_000 },
  async () => {
    const db = openDatabase(":memory:");
    try {
      const provider = new FakeProvider([
        { content: "第一轮回复" },
        { content: "第二轮回复" },
      ]);
      const firstContent: LlmContentPart[] = [
        { type: "text", text: "这是什么颜色" },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,AAAA" },
        },
      ];
      await runMainTurn({
        db,
        provider,
        userContent: firstContent,
        now: () => 1_000,
      });

      const firstMessages = provider.calls[0]?.messages ?? [];
      const firstUser = firstMessages.at(-1);
      assert.equal(firstUser?.role, "user");
      assert.deepEqual(
        firstUser?.content,
        firstContent,
        "预期当前轮图片分片原样进 provider",
      );

      await runMainTurn({
        db,
        provider,
        userMessage: "第二轮",
        now: () => 2_000,
      });
      const secondMessages = provider.calls[1]?.messages ?? [];
      const historyUser = secondMessages.find((message) => message.role === "user");
      assert.ok(historyUser !== undefined, "预期第二轮仍带历史 user 消息");
      assert.equal(
        typeof historyUser.content,
        "string",
        "预期历史轮 content 折成纯文本而不是数组",
      );
      assert.equal(
        historyUser.content,
        "这是什么颜色[图片]",
        "预期 llmContentText 用占位符代替历史图片",
      );
      assert.equal(
        secondMessages.at(-1)?.content,
        "第二轮",
        "预期当前轮纯文本原样进入 provider",
      );

      const stored = listRecentMessages(db, 10);
      assert.equal(stored[0]?.content, "这是什么颜色[图片]");

      await assert.rejects(
        () =>
          runMainTurn({
            db,
            provider: new FakeProvider([]),
            userMessage: "文本",
            userContent: "也传了",
          }),
        (error: unknown) =>
          error instanceof ContractError &&
          error.code === ERROR_CODES.E_INVALID_ARGUMENT,
        "预期同时给 userMessage/userContent 抛 E_INVALID_ARGUMENT",
      );
      await assert.rejects(
        () => runMainTurn({ db, provider: new FakeProvider([]) }),
        (error: unknown) =>
          error instanceof ContractError &&
          error.code === ERROR_CODES.E_INVALID_ARGUMENT,
        "预期两者都不给也抛 E_INVALID_ARGUMENT",
      );
    } finally {
      db.close();
    }
  },
);

test("M9-03 token 估算：图片每张 800，文本仍按字符数/2，数组 content 不再按分片数计数", () => {
  const usage = estimateTokenUsage(
    [
      {
        role: "user",
        content: [
          { type: "text", text: "1234" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AA" } },
          { type: "image_url", image_url: { url: "data:image/png;base64,BB" } },
        ],
      },
    ],
    null,
    [],
  );
  assert.equal(usage.inputTokens, 2 + 800 * 2);
  assert.equal(usage.estimated, true);
});

test("M9-03 前端接线：回形针/拖拽/粘贴、canvas 压缩参数、引用条与用户气泡 blockquote、/uploads 代理", () => {
  for (const path of [
    "src/web/src/components/ChatAttachmentViews.tsx",
    "src/web/src/components/ChatQuoteBar.tsx",
  ]) {
    assert.ok(existsSync(join(root, path)), `预期组件存在：${path}`);
  }

  const chat = read("src/web/src/pages/Chat.tsx");
  for (const marker of [
    "onPaste={handlePaste}",
    "onDrop={handleDrop}",
    "onDragOver={handleDragOver}",
    "compressImageFile(",
    "readFileBase64(",
    "<ChatQuoteBar",
    "<MessageAttachments",
    "buildQuotedMessage",
    "type=\"file\"",
    "multiple",
  ]) {
    assert.ok(chat.includes(marker), `预期 Chat.tsx 包含 ${marker}`);
  }

  const attachmentView = read("src/web/src/components/ChatAttachmentViews.tsx");
  for (const marker of [
    "MAX_IMAGE_EDGE = 1568",
    "JPEG_QUALITY = 0.85",
    "canvas.toDataURL(mime, JPEG_QUALITY)",
    "keepPng",
    "/uploads/",
    "<Image",
    "preview={{ mask",
  ]) {
    assert.ok(
      attachmentView.includes(marker),
      `预期附件组件包含 ${marker}`,
    );
  }

  const quoteView = read("src/web/src/components/ChatQuoteBar.tsx");
  for (const marker of ["> 引用：", "splitQuotedMessage", "QUOTE_PREVIEW_CHARS = 80"]) {
    assert.ok(quoteView.includes(marker), `预期引用组件包含 ${marker}`);
  }

  const server = read("src/server/index.ts");
  for (const marker of [
    "app.get('/uploads/:id'",
    "bodyLimit: CHAT_BODY_LIMIT_BYTES",
    "Content-Disposition",
    "saveChatAttachments(",
    "buildChatUserContent(",
  ]) {
    assert.ok(server.includes(marker), `预期 server 包含 ${marker}`);
  }

  const vite = read("src/web/vite.config.ts");
  assert.ok(vite.includes('"/uploads"'), "预期 Vite 代理包含 /uploads");
});
