import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { DEFAULT_DAILY_BUDGET_TOKENS, getLocalDayRange } from "../../src/runtime/watchdog.ts";
import type { Scheduler } from "../../src/runtime/scheduler.ts";
import { createApp } from "../../src/server/index.ts";
import { insertArtifact } from "../../src/store/artifacts.ts";
import { upsertFact } from "../../src/store/facts.ts";
import { insertLlmCall } from "../../src/store/llm-calls.ts";
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
