import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, parse as parsePath } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { runMainTurn } from "../../src/agent/main-loop.ts";
import { ContractError, ERROR_CODES } from "../../src/core/errors.ts";
import type { PermissionMode } from "../../src/core/types.ts";
import { DeepSeekProvider } from "../../src/providers/deepseek.ts";
import { FakeProvider, type FakeStep } from "../../src/providers/fake.ts";
import { createTask } from "../../src/runtime/ops.ts";
import { createScheduler } from "../../src/runtime/scheduler.ts";
import type { Scheduler } from "../../src/runtime/scheduler.ts";
import { getLocalDayRange } from "../../src/runtime/watchdog.ts";
import { createApp } from "../../src/server/index.ts";
import { insertArtifact, searchArtifacts } from "../../src/store/artifacts.ts";
import { insertLlmCall } from "../../src/store/llm-calls.ts";
import { openDatabase, migrate, SCHEMA_VERSION } from "../../src/store/migrate.ts";
import { getTask, insertTask, listTasks } from "../../src/store/repo.ts";
import {
  DEFAULT_SETTINGS,
  getSettings,
  resolveDefaultWorkspace,
  saveSettings,
  validateSettingsInput,
} from "../../src/store/settings.ts";

const root = join(import.meta.dirname, "..", "..");

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function withDb(fn: (db: DatabaseSync) => Promise<void> | void): Promise<void> {
  const dir = tempDir("task-terminal-m10-db-");
  const db = openDatabase(join(dir, "test.db"));
  try {
    await fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
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

function asArray(value: unknown, label: string): unknown[] {
  assert.ok(Array.isArray(value), `预期 ${label} 是数组，实际 ${String(value)}`);
  return value;
}

function assertInvalidSettings(partial: unknown, field: string): void {
  assert.throws(
    () => validateSettingsInput(partial),
    (error: unknown) =>
      error instanceof ContractError &&
      error.code === ERROR_CODES.E_INVALID_ARGUMENT &&
      error.message.includes(field),
    `预期 ${field} 校验失败并抛 E_INVALID_ARGUMENT`,
  );
}

function toolStep(id: string, name: string, args: unknown): FakeStep {
  return {
    toolCalls: [
      {
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}

function submitStep(summary: string): FakeStep {
  return toolStep(`call_${summary}`, "submit_result", {
    summary,
    findings: [],
    artifacts: [],
  });
}

// ════════════════════════════════════════════════════════════════
// 验收 1：迁移 v2（v1 升级数据保留、重复迁移幂等）
// ════════════════════════════════════════════════════════════════

test("M10-01 迁移 v2：v1 库（含 artifacts）升级后数据保留、设置表就位、重复迁移幂等", () => {
  const dir = tempDir("task-terminal-m10-migrate-");
  const file = join(dir, "upgrade.db");
  let db = openDatabase(file);
  try {
    assert.equal(SCHEMA_VERSION, 2, "预期 SCHEMA_VERSION=2");

    const task = insertTask(db, {
      title: "升级前任务",
      goal: "验证 v1→v2 数据不丢",
      workspace: join(dir, "workspace"),
      now: 1_000,
    });
    insertArtifact(db, {
      taskId: task.id,
      kind: "note",
      title: "升级保留的产物",
      summary: "升级保留关键字：迁移不丢数据",
      now: 1_001,
    });

    // 构造真实的 v1 形态：没有 app_settings，schema_migrations 停在 1。
    db.exec("DROP TABLE app_settings");
    db.exec("UPDATE schema_migrations SET version = 1");
    db.close();

    db = openDatabase(file);
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'")
      .get() as unknown as { name: string } | undefined;
    assert.equal(table?.name, "app_settings", "预期升级后 app_settings 存在");

    const version = db
      .prepare("SELECT COUNT(*) AS count, MAX(version) AS version FROM schema_migrations")
      .get() as unknown as { count: number | bigint; version: number | bigint };
    assert.equal(Number(version.count), 1, "预期沿用单行当前版本形态");
    assert.equal(Number(version.version), 2, "预期迁移版本推进到 2");

    const taskCount = db.prepare("SELECT COUNT(*) AS count FROM tasks").get() as unknown as {
      count: number | bigint;
    };
    assert.equal(Number(taskCount.count), 1, "预期 v1 任务行保留");
    assert.equal(
      searchArtifacts(db, "升级保留").length,
      1,
      "预期 v1 产物与 FTS 索引在升级后仍可检索",
    );

    assert.deepEqual(getSettings(db), DEFAULT_SETTINGS, "预期升级后设置为默认值");

    saveSettings(db, { dailyBudgetTokens: 120_000 }, 2_000);
    migrate(db);
    migrate(db);
    assert.equal(getSettings(db).dailyBudgetTokens, 120_000, "预期重复迁移不清空已保存设置");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ════════════════════════════════════════════════════════════════
// 验收 2：settings CRUD、深合并与字段级校验
// ════════════════════════════════════════════════════════════════

test("M10-01 settings：默认值、深合并持久化、坏 JSON E_INTERNAL、字段级校验、工作区解析顺序", () => {
  return withDb((db) => {
    const workspace = tempDir("task-terminal-m10-ws-");
    const envWorkspace = tempDir("task-terminal-m10-env-ws-");
    const missing = join(workspace, "missing-dir");
    try {
      assert.deepEqual(getSettings(db), DEFAULT_SETTINGS, "预期无记录返回默认设置");

      const first = saveSettings(
        db,
        {
          workspaceDir: workspace,
          main: { model: "  deepseek-reasoner  ", temperature: 0.2 },
          dailyBudgetTokens: 80_000,
        },
        2_000,
      );
      assert.equal(first.main.model, "deepseek-reasoner", "预期 model 去除首尾空白");
      assert.equal(first.main.temperature, 0.2, "预期 temperature 写入");
      assert.equal(first.main.topP, 1, "预期未给的 main.topP 保留默认");
      assert.equal(first.subagent.model, "deepseek-chat", "预期 subagent 保留默认");
      assert.equal(first.workspaceDir, realpathSync(workspace), "预期存 realpath");
      assert.equal(first.dailyBudgetTokens, 80_000);

      const row = db
        .prepare("SELECT value, updated_at FROM app_settings WHERE key = 'app'")
        .get() as unknown as { value: string; updated_at: number };
      assert.equal(row.updated_at, 2_000, "预期 updated_at 使用注入时钟");
      assert.equal(JSON.parse(row.value).main.model, "deepseek-reasoner");

      const second = saveSettings(db, { main: { topP: 0.6 } }, 3_000);
      assert.equal(second.main.topP, 0.6, "预期深合并写入 topP");
      assert.equal(second.main.model, "deepseek-reasoner", "预期深合并保留已有 model");
      assert.equal(second.main.temperature, 0.2, "预期深合并保留已有 temperature");
      assert.equal(second.workspaceDir, realpathSync(workspace), "预期保留工作区");
      const updated = db
        .prepare("SELECT updated_at FROM app_settings WHERE key = 'app'")
        .get() as unknown as { updated_at: number };
      assert.equal(updated.updated_at, 3_000, "预期第二次保存刷新 updated_at");

      assertInvalidSettings({ main: { temperature: 2.1 } }, "main.temperature");
      assertInvalidSettings({ main: { topP: -0.01 } }, "main.topP");
      assertInvalidSettings({ main: { maxTokens: 255 } }, "main.maxTokens");
      assertInvalidSettings({ main: { maxTokens: 8193 } }, "main.maxTokens");
      assertInvalidSettings({ dailyBudgetTokens: 49_999 }, "dailyBudgetTokens");
      assertInvalidSettings({ main: { thinkingLevel: "ultra" } }, "main.thinkingLevel");
      assertInvalidSettings({ mainTaskDefaultPermission: "admin" }, "mainTaskDefaultPermission");
      assertInvalidSettings({ subagentPermissionCap: "admin" }, "subagentPermissionCap");
      assertInvalidSettings({ main: { model: "" } }, "main.model");
      assertInvalidSettings({ main: { model: "m".repeat(61) } }, "main.model");
      assertInvalidSettings({ workspaceDir: missing }, "workspaceDir");

      // 校验失败不落库：最后一次合法值仍是 3000 那次的结果。
      assert.equal(getSettings(db).main.topP, 0.6, "预期非法输入不改变已保存设置");

      // 坏 JSON 必须抛 E_INTERNAL，而不是静默返回默认值。
      db.prepare("UPDATE app_settings SET value = '{broken' WHERE key = 'app'").run();
      assert.throws(
        () => getSettings(db),
        (error: unknown) => error instanceof ContractError && error.code === ERROR_CODES.E_INTERNAL,
        "预期坏 JSON 抛 E_INTERNAL",
      );
      db.prepare("DELETE FROM app_settings").run();

      // 工作区解析：settings > env WORKSPACE_DIR > <repo>/workspace。
      const previousEnv = process.env.WORKSPACE_DIR;
      try {
        delete process.env.WORKSPACE_DIR;
        assert.equal(
          resolveDefaultWorkspace(db),
          join(root, "workspace"),
          "预期无设置/无 env 时回退仓库 workspace",
        );
        process.env.WORKSPACE_DIR = envWorkspace;
        assert.equal(resolveDefaultWorkspace(db), envWorkspace, "预期环境变量优先于仓库默认");
        saveSettings(db, { workspaceDir: workspace }, 4_000);
        assert.equal(
          resolveDefaultWorkspace(db),
          realpathSync(workspace),
          "预期设置优先于环境变量",
        );
      } finally {
        if (previousEnv === undefined) delete process.env.WORKSPACE_DIR;
        else process.env.WORKSPACE_DIR = previousEnv;
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(envWorkspace, { recursive: true, force: true });
    }
  });
});

// ════════════════════════════════════════════════════════════════
// 验收 3：GET/PUT /settings 路由（400 字段级错误、合并默认返回）
// ════════════════════════════════════════════════════════════════

test("M10-01 路由 GET/PUT /settings：默认合并、校验 400 指明字段、保存后读回、POST /tasks 用设置工作区", async () => {
  const workspace = tempDir("task-terminal-m10-route-ws-");
  const fallback = tempDir("task-terminal-m10-route-fallback-");
  await withDb(async (db) => {
    const app = createApp({
      db,
      scheduler: stubScheduler(),
      defaultWorkspace: fallback,
      now: () => 5_000,
    });
    try {
      const initial = await app.inject({ method: "GET", url: "/settings" });
      assert.equal(initial.statusCode, 200);
      assert.deepEqual(initial.json(), DEFAULT_SETTINGS, "预期 GET 合并默认值返回");

      const invalid = await app.inject({
        method: "PUT",
        url: "/settings",
        payload: {
          main: { temperature: 3, thinkingLevel: "ultra" },
          workspaceDir: join(workspace, "nope"),
        },
      });
      assert.equal(invalid.statusCode, 400, "预期非法设置返回 400");
      const invalidBody = asRecord(invalid.json(), "invalid settings body");
      const invalidError = asRecord(invalidBody.error, "invalid settings error");
      assert.equal(invalidError.code, ERROR_CODES.E_INVALID_ARGUMENT);
      const invalidMessage = String(invalidError.message);
      for (const field of ["main.temperature", "main.thinkingLevel", "workspaceDir"]) {
        assert.ok(invalidMessage.includes(field), `预期错误指明字段 ${field}`);
      }
      assert.deepEqual(getSettings(db), DEFAULT_SETTINGS, "预期 400 不改动已保存设置");

      const saved = await app.inject({
        method: "PUT",
        url: "/settings",
        payload: {
          workspaceDir: workspace,
          main: {
            model: "deepseek-reasoner",
            thinkingLevel: "high",
            temperature: 0.3,
            topP: 0.8,
            maxTokens: 2048,
          },
          subagent: { model: "subagent-model" },
          mainTaskDefaultPermission: "read-only",
          subagentPermissionCap: "read-only",
          dailyBudgetTokens: 100_000,
        },
      });
      assert.equal(saved.statusCode, 200, "预期合法设置保存成功");
      const savedBody = asRecord(saved.json(), "saved settings");

      const reread = await app.inject({ method: "GET", url: "/settings" });
      assert.equal(reread.statusCode, 200);
      assert.deepEqual(reread.json(), savedBody, "预期 GET 返回保存后的设置");

      const settings = getSettings(db);
      assert.equal(settings.main.model, "deepseek-reasoner");
      assert.equal(settings.main.thinkingLevel, "high");
      assert.equal(settings.main.temperature, 0.3);
      assert.equal(settings.main.topP, 0.8);
      assert.equal(settings.main.maxTokens, 2048);
      assert.equal(settings.subagent.model, "subagent-model");
      assert.equal(settings.subagent.temperature, 1, "预期 subagent 未给字段保留默认");
      assert.equal(settings.mainTaskDefaultPermission, "read-only");
      assert.equal(settings.subagentPermissionCap, "read-only");
      assert.equal(settings.dailyBudgetTokens, 100_000);
      assert.equal(settings.workspaceDir, realpathSync(workspace));

      const overview = await app.inject({ method: "GET", url: "/settings/overview" });
      assert.equal(overview.statusCode, 200);
      const overviewBody = asRecord(overview.json(), "overview");
      assert.equal(overviewBody.model, "deepseek-reasoner");
      assert.equal(overviewBody.dailyBudgetTokens, 100_000);

      // POST /tasks 未带 workspace 时，settings.workspaceDir 优先于注入的 fallback。
      const created = await app.inject({
        method: "POST",
        url: "/tasks",
        payload: { title: "设置工作区任务", goal: "验证 server 解析顺序" },
      });
      assert.equal(created.statusCode, 201);
      const createdTask = asRecord(created.json(), "created task");
      assert.equal(
        createdTask.workspace,
        realpathSync(workspace),
        "预期 POST /tasks 使用设置里的工作区而非注入 fallback",
      );
    } finally {
      await app.close();
      rmSync(workspace, { recursive: true, force: true });
      rmSync(fallback, { recursive: true, force: true });
    }
  });
});

// ════════════════════════════════════════════════════════════════
// 验收 4：主线每轮读取设置 + 调用方显式参数优先
// ════════════════════════════════════════════════════════════════

test("M10-01 主线每轮生效：改设置后下一轮 ChatParams 变化，显式入参覆盖设置", async () => {
  await withDb(async (db) => {
    const workspace = tempDir("task-terminal-m10-main-ws-");
    try {
      const provider = new FakeProvider([
        { content: "第一轮" },
        { content: "第二轮" },
        { content: "第三轮" },
      ]);

      saveSettings(db, {
        main: {
          model: "main-model-a",
          thinkingLevel: "high",
          temperature: 0.3,
          topP: 0.7,
          maxTokens: 1234,
        },
      });

      await runMainTurn({
        db,
        provider,
        userMessage: "第一轮",
        workspace,
        now: () => 1_000,
      });
      const first = provider.calls[0];
      assert.ok(first !== undefined, "预期第一次 provider 调用");
      assert.equal(first.model, "main-model-a");
      assert.equal(first.reasoningEffort, "high");
      assert.equal(first.temperature, 0.3);
      assert.equal(first.topP, 0.7);
      assert.equal(first.maxTokens, 1234);

      // 修改设置后不重建 provider / 不重启，下一轮立即读取新值。
      saveSettings(db, {
        main: {
          model: "main-model-b",
          thinkingLevel: "off",
          temperature: 0.9,
          topP: 0.2,
          maxTokens: 4321,
        },
      });
      await runMainTurn({
        db,
        provider,
        userMessage: "第二轮",
        workspace,
        now: () => 2_000,
      });
      const second = provider.calls[1];
      assert.ok(second !== undefined, "预期第二次 provider 调用");
      assert.equal(second.model, "main-model-b");
      assert.equal(second.reasoningEffort, undefined, "预期 thinkingLevel=off 不发送");
      assert.equal(second.temperature, 0.9);
      assert.equal(second.topP, 0.2);
      assert.equal(second.maxTokens, 4321);

      // 调用方显式传入的同名参数优先于设置。
      await runMainTurn({
        db,
        provider,
        userMessage: "第三轮",
        workspace,
        model: "caller-model",
        reasoningEffort: "low",
        temperature: 0.55,
        topP: 0.45,
        maxTokens: 999,
        now: () => 3_000,
      });
      const third = provider.calls[2];
      assert.ok(third !== undefined, "预期第三次 provider 调用");
      assert.equal(third.model, "caller-model");
      assert.equal(third.reasoningEffort, "low");
      assert.equal(third.temperature, 0.55);
      assert.equal(third.topP, 0.45);
      assert.equal(third.maxTokens, 999);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

// ════════════════════════════════════════════════════════════════
// 验收 5：子代理 scheduler 路径每 tick 读取设置
// ════════════════════════════════════════════════════════════════

test("M10-01 子代理每 tick 生效：scheduler 用设置组装 model/providerParams 并跑完任务", async () => {
  await withDb(async (db) => {
    const workspace = tempDir("task-terminal-m10-sub-ws-");
    try {
      const provider = new FakeProvider([submitStep("子代理第一轮"), submitStep("子代理第二轮")]);
      const scheduler = createScheduler({
        db,
        provider,
        reapOnStart: false,
        now: () => 10_000,
      });

      saveSettings(db, {
        subagent: {
          model: "subagent-model-a",
          thinkingLevel: "medium",
          temperature: 0.4,
          topP: 0.6,
          maxTokens: 2048,
        },
      });
      const firstTask = createTask(
        db,
        { title: "子代理第一轮", goal: "验证设置", workspace, now: 10_000 },
        "user",
      );
      const firstTick = await scheduler.tick();
      assert.equal(firstTick.started, true, "预期第一个任务被调度");
      const firstCall = provider.calls[0];
      assert.ok(firstCall !== undefined, "预期子代理第一次 provider 调用");
      assert.equal(firstCall.model, "subagent-model-a");
      assert.equal(firstCall.reasoningEffort, "medium");
      assert.equal(firstCall.temperature, 0.4);
      assert.equal(firstCall.topP, 0.6);
      assert.equal(firstCall.maxTokens, 2048);
      assert.equal(listTasks(db, { status: "completed" }).length, 1);

      saveSettings(db, {
        subagent: {
          model: "subagent-model-b",
          thinkingLevel: "off",
          temperature: 0.1,
          topP: 0.9,
          maxTokens: 512,
        },
      });
      const secondTask = createTask(
        db,
        { title: "子代理第二轮", goal: "验证设置更新", workspace, now: 11_000 },
        "user",
      );
      const secondTick = await scheduler.tick();
      assert.equal(secondTick.started, true, "预期第二个任务被调度");
      const secondCall = provider.calls[1];
      assert.ok(secondCall !== undefined, "预期子代理第二次 provider 调用");
      assert.equal(secondCall.model, "subagent-model-b");
      assert.equal(secondCall.reasoningEffort, undefined, "预期思考关闭时不发送");
      assert.equal(secondCall.temperature, 0.1);
      assert.equal(secondCall.topP, 0.9);
      assert.equal(secondCall.maxTokens, 512);

      const completed = listTasks(db, { status: "completed" });
      assert.deepEqual(
        completed.map((task) => task.id).sort(),
        [firstTask.id, secondTask.id].sort(),
        "预期两条任务都完成",
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

// ════════════════════════════════════════════════════════════════
// 验收 5b：scheduler 日预算读取设置
// ════════════════════════════════════════════════════════════════

test("M10-01 日预算来自设置：每 tick 用 settings.dailyBudgetTokens 做 gate", async () => {
  await withDb(async (db) => {
    const workspace = tempDir("task-terminal-m10-budget-ws-");
    const now = new Date(2026, 9, 24, 12, 0, 0, 0).getTime();
    const { startMs } = getLocalDayRange(now);
    try {
      insertLlmCall(db, {
        purpose: "agent",
        model: "deepseek-chat",
        inputTokens: 50_000,
        outputTokens: 0,
        ts: startMs + 1_000,
      });
      saveSettings(db, { dailyBudgetTokens: 50_000 }, now);
      const scheduler = createScheduler({
        db,
        provider: new FakeProvider([]),
        reapOnStart: false,
        now: () => now,
      });
      const task = createTask(
        db,
        { title: "预算拦截任务", goal: "验证日预算来自设置", workspace, now },
        "user",
      );

      const result = await scheduler.tick();
      assert.equal(result.started, false, "预期用量达到设置预算时不派任务");
      assert.equal(result.reason, "budget");
      assert.ok(result.gate !== undefined);
      assert.equal(result.gate.spent, 50_000);
      assert.equal(result.gate.budget, 50_000, "预期 gate 使用设置里的日预算");
      assert.equal(getTask(db, task.id)?.status, "queued", "预期任务保持 queued");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

// ════════════════════════════════════════════════════════════════
// 验收 6：create_task 权限钳制
// ════════════════════════════════════════════════════════════════

test("M10-01 权限钳制：默认权限来自设置，cap=read-only 时 workspace-write 请求落库 read-only", async () => {
  await withDb(async (db) => {
    const workspace = tempDir("task-terminal-m10-perm-ws-");
    try {
      // 第一轮：未给 permission → 用 mainTaskDefaultPermission=read-only。
      saveSettings(db, {
        mainTaskDefaultPermission: "read-only",
        subagentPermissionCap: "workspace-write",
      });
      const firstProvider = new FakeProvider([
        toolStep("call_create_1", "create_task", {
          title: "默认权限任务",
          goal: "验证 mainTaskDefaultPermission",
        }),
        { content: "已派活 1" },
      ]);
      await runMainTurn({
        db,
        provider: firstProvider,
        userMessage: "派一个任务",
        workspace,
        now: () => 20_000,
      });
      const firstTask = listTasks(db).find((task) => task.title === "默认权限任务");
      assert.ok(firstTask !== undefined, "预期第一个任务落库");
      assert.equal(firstTask.permission, "read-only", "预期未给 permission 用设置默认");

      // 第二轮：cap=read-only 钳制模型请求的 workspace-write。
      saveSettings(db, {
        mainTaskDefaultPermission: "workspace-write",
        subagentPermissionCap: "read-only",
      });
      const secondProvider = new FakeProvider([
        toolStep("call_create_2", "create_task", {
          title: "被钳制任务",
          goal: "验证 cap 钳制",
          permission: "workspace-write",
        }),
        { content: "已派活 2" },
      ]);
      await runMainTurn({
        db,
        provider: secondProvider,
        userMessage: "再派一个任务",
        workspace,
        now: () => 21_000,
      });
      const secondTask = listTasks(db).find((task) => task.title === "被钳制任务");
      assert.ok(secondTask !== undefined, "预期第二个任务落库");
      assert.equal(
        secondTask.permission,
        "read-only",
        "预期 cap=read-only 时模型请求 workspace-write 被钳制",
      );
      assert.equal(
        secondTask.permission satisfies PermissionMode,
        "read-only",
        "预期落库权限是合法 PermissionMode",
      );

      // 事件 payload 里的 permission 也必须是钳制后的值。
      const createdEvent = db
        .prepare("SELECT payload FROM events WHERE task_id = ? AND type = 'task.created'")
        .get(secondTask.id) as unknown as { payload: string };
      assert.equal(
        JSON.parse(createdEvent.payload).permission,
        "read-only",
        "预期 task.created 事件记录钳制后的权限",
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

// ════════════════════════════════════════════════════════════════
// 验收 7：DeepSeek payload 映射
// ════════════════════════════════════════════════════════════════

test("M10-01 payload 映射：temperature/top_p/max_tokens/reasoning_effort，缺省不出现", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      try {
        bodies.push(asRecord(JSON.parse(Buffer.concat(chunks).toString("utf8")), "request body"));
      } catch {
        bodies.push({});
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  try {
    const address = server.address();
    assert.ok(address !== null && typeof address === "object", "预期 mock server 端口");
    const provider = new DeepSeekProvider({
      apiKey: "test-key",
      baseUrl: `http://127.0.0.1:${String(address.port)}`,
    });

    await provider.chat({
      messages: [{ role: "user", content: "带参数" }],
      temperature: 0.35,
      topP: 0.85,
      maxTokens: 777,
      reasoningEffort: "medium",
    });
    const first = bodies[0];
    assert.ok(first !== undefined, "预期收到第一次请求体");
    assert.equal(first.temperature, 0.35);
    assert.equal(first.top_p, 0.85);
    assert.equal(first.max_tokens, 777);
    assert.equal(first.reasoning_effort, "medium");
    assert.equal(first.model, "deepseek-chat");

    await provider.chat({ messages: [{ role: "user", content: "无参数" }] });
    const second = bodies[1];
    assert.ok(second !== undefined, "预期收到第二次请求体");
    assert.equal("temperature" in second, false, "预期缺省不发送 temperature");
    assert.equal("top_p" in second, false, "预期缺省不发送 top_p");
    assert.equal("max_tokens" in second, false, "预期缺省不发送 max_tokens");
    assert.equal("reasoning_effort" in second, false, "预期 reasoningEffort 缺省/off 时不出现");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ════════════════════════════════════════════════════════════════
// 验收 8：/fs/browse
// ════════════════════════════════════════════════════════════════

test("M10-01 /fs/browse：仅目录名+可进入、文件路径 400、默认盘根、超 500 截断标注", async () => {
  await withDb(async (db) => {
    const base = tempDir("task-terminal-m10-browse-");
    const app = createApp({
      db,
      scheduler: stubScheduler(),
      defaultWorkspace: base,
      now: () => 30_000,
    });
    try {
      mkdirSync(join(base, "alpha"));
      mkdirSync(join(base, "beta"));
      mkdirSync(join(base, "trunc"));
      writeFileSync(join(base, "secret.txt"), "TOP-SECRET-CONTENT", "utf8");
      for (let index = 0; index < 501; index += 1) {
        mkdirSync(join(base, "trunc", `d${String(index).padStart(3, "0")}`));
      }

      const listed = await app.inject({
        method: "GET",
        url: `/fs/browse?path=${encodeURIComponent(base)}`,
      });
      assert.equal(listed.statusCode, 200);
      const listedBody = asRecord(listed.json(), "browse body");
      assert.equal(listedBody.path, realpathSync(base));
      const entries = asArray(listedBody.entries, "browse entries").map((entry) =>
        asRecord(entry, "browse entry"),
      );
      assert.deepEqual(
        entries.map((entry) => entry.name),
        ["alpha", "beta", "trunc"],
        "预期只列目录、按名称排序、不包含文件",
      );
      for (const entry of entries) {
        assert.deepEqual(
          Object.keys(entry).sort(),
          ["enterable", "name"],
          "预期每个条目只有目录名与是否可进入",
        );
        assert.equal(entry.enterable, true);
      }
      assert.equal(
        JSON.stringify(listedBody).includes("TOP-SECRET-CONTENT"),
        false,
        "预期不返回文件内容",
      );
      assert.equal(JSON.stringify(listedBody).includes("secret.txt"), false, "预期不返回文件名");
      assert.equal(listedBody.truncated, false);

      const filePath = await app.inject({
        method: "GET",
        url: `/fs/browse?path=${encodeURIComponent(join(base, "secret.txt"))}`,
      });
      assert.equal(filePath.statusCode, 400, "预期文件路径返回 400");
      const fileError = asRecord(asRecord(filePath.json(), "file error").error, "error");
      assert.equal(fileError.code, ERROR_CODES.E_INVALID_ARGUMENT);
      assert.equal(String(fileError.message).includes(base), false, "预期错误不回显本机路径");

      const missing = await app.inject({
        method: "GET",
        url: `/fs/browse?path=${encodeURIComponent(join(base, "missing"))}`,
      });
      assert.equal(missing.statusCode, 400, "预期不存在路径返回 400");

      const defaulted = await app.inject({ method: "GET", url: "/fs/browse" });
      assert.equal(defaulted.statusCode, 200, "预期缺省 path 可浏览");
      assert.equal(
        asRecord(defaulted.json(), "default browse").path,
        parsePath(process.cwd()).root,
        "预期缺省为 process.cwd() 所在盘根",
      );

      const truncated = await app.inject({
        method: "GET",
        url: `/fs/browse?path=${encodeURIComponent(join(base, "trunc"))}`,
      });
      assert.equal(truncated.statusCode, 200);
      const truncatedBody = asRecord(truncated.json(), "truncated browse");
      assert.equal(
        asArray(truncatedBody.entries, "truncated entries").length,
        500,
        "预期最多返回 500 条",
      );
      assert.equal(truncatedBody.truncated, true, "预期超 500 标注截断");
      assert.equal(truncatedBody.total, 501, "预期 total 是真实目录数");
    } finally {
      await app.close();
      rmSync(base, { recursive: true, force: true });
    }
  });
});

// ════════════════════════════════════════════════════════════════
// 验收 9：脚本注册
// ════════════════════════════════════════════════════════════════

test("M10-01 脚本注册：verify 包含 m10，verify:m10 指向新测试文件", () => {
  const pkg = asRecord(JSON.parse(read("package.json")) as unknown, "package.json");
  const scripts = asRecord(pkg.scripts, "scripts");
  assert.equal(
    scripts["verify:m10"],
    "node --test --test-isolation=none scripts/verify/m10.test.ts",
  );
  assert.ok(
    String(scripts.verify).includes("scripts/verify/m10.test.ts"),
    "预期总 verify 追加 m10.test.ts",
  );
});

// ════════════════════════════════════════════════════════════════
// 验收 10：M10-02 设置页源码接线
// ════════════════════════════════════════════════════════════════

test("M10-02 设置页源码：模型/思考、权限、工作空间、日预算分区与 PUT 保存调用点", () => {
  const settings = read("src/web/src/pages/Settings.tsx");
  for (const marker of [
    "模型与思考",
    "deepseek-chat",
    "deepseek-reasoner",
    "自定义",
    "关闭",
    "低",
    "中",
    "高",
    "top_p",
    "单轮输出上限",
    "主线派任务默认权限",
    "子代理权限上限",
    "选只读则所有任务强制只读",
    "工作空间",
    "日预算",
    "今日用量",
    "设置即时生效（下一轮对话/下一次任务），无需重启",
    "DirectoryBrowserModal",
    "putSettings",
  ]) {
    assert.ok(settings.includes(marker), `预期 Settings.tsx 包含 ${marker}`);
  }

  // m9 的记忆/统计区块必须保留。
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
    "统计",
  ]) {
    assert.ok(settings.includes(marker), `预期 Settings.tsx 保留 ${marker}`);
  }

  const settingsApi = read("src/web/src/settingsApi.ts");
  for (const marker of [
    "/settings",
    "/fs/browse",
    'method: "PUT"',
    "SettingsPatch",
    "parseSettingsFieldErrors",
  ]) {
    assert.ok(settingsApi.includes(marker), `预期 settingsApi.ts 包含 ${marker}`);
  }
});

test("M10-02 目录浏览器源码：面包屑、上级/前往/复制、enterable、truncated 与确认回填", () => {
  const browser = read("src/web/src/components/DirectoryBrowser.tsx");
  for (const marker of [
    "buildBreadcrumbs",
    "pathSeparator",
    "parentDirectory",
    "前往",
    "复制当前路径",
    "使用此目录",
    "truncated",
    "enterable",
    "DirectoryBrowserPanel",
    "DirectoryBrowserModal",
    "destroyOnHidden",
  ]) {
    assert.ok(browser.includes(marker), `预期 DirectoryBrowser.tsx 包含 ${marker}`);
  }
});

test("M10-02 向导源码：App 首启判定/会话跳过，三步向导内嵌目录浏览器并 PUT 保存", () => {
  const app = read("src/web/src/App.tsx");
  for (const marker of [
    'import SetupWizard from "./components/SetupWizard"',
    "workspaceDir === null",
    "WIZARD_SKIP_KEY",
    "sessionStorage",
    "localStorage",
    "readSessionId",
    "<SetupWizard",
    "onSkip={dismissWizard}",
    "onSaved={finishWizard}",
  ]) {
    assert.ok(app.includes(marker), `预期 App.tsx 包含 ${marker}`);
  }

  const wizard = read("src/web/src/components/SetupWizard.tsx");
  for (const marker of [
    "欢迎使用任务终端",
    "选择工作空间",
    "开始使用",
    "稍后再说",
    "DirectoryBrowserPanel",
    "putSettings({ workspaceDir })",
    "workspaceDir",
    "上一步",
  ]) {
    assert.ok(wizard.includes(marker), `预期 SetupWizard.tsx 包含 ${marker}`);
  }

  const vite = read("src/web/vite.config.ts");
  assert.ok(vite.includes('"/fs"'), "预期 Vite 代理包含 /fs");
  assert.ok(vite.includes('"/settings"'), "预期 Vite 代理仍包含 /settings");
});

test("M10-02 依赖纪律：package.json 依赖清单与 M10-01 一致，零新增", () => {
  const pkg = asRecord(JSON.parse(read("package.json")) as unknown, "package.json");
  const dependencies = asRecord(pkg.dependencies, "dependencies");
  const devDependencies = asRecord(pkg.devDependencies, "devDependencies");
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

// ════════════════════════════════════════════════════════════════
// 验收 11：M10-02 前端构建
// ════════════════════════════════════════════════════════════════

test("M10-02 构建：pnpm build 退出码 0 且 dist/index.html 存在", { timeout: 240_000 }, () => {
  const buildResult =
    process.platform === "win32"
      ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "pnpm build"], {
          cwd: root,
          stdio: "inherit",
          env: process.env,
        })
      : spawnSync("pnpm", ["build"], {
          cwd: root,
          stdio: "inherit",
          env: process.env,
        });

  assert.equal(
    buildResult.status,
    0,
    `预期 pnpm build 退出码 0，实际 ${String(buildResult.status)}（error=${buildResult.error?.message ?? "none"}）`,
  );
  assert.ok(existsSync(join(root, "dist", "index.html")), "预期 dist/index.html 存在");
});

// ════════════════════════════════════════════════════════════════
// 验收 12：M10-03 划选引用与选项 chips 源码接线
// ════════════════════════════════════════════════════════════════

test("M10-03 划选引用源码：document 监听、气泡归属、坐标钳制与引用所选按钮", () => {
  for (const path of [
    "src/web/src/components/SelectionQuoteButton.tsx",
    "src/web/src/components/OptionChips.tsx",
  ]) {
    assert.ok(existsSync(join(root, path)), `预期组件存在：${path}`);
  }

  const chat = read("src/web/src/pages/Chat.tsx");
  for (const marker of [
    'document.addEventListener("selectionchange"',
    'document.addEventListener("mouseup"',
    "getBoundingClientRect",
    "data-chat-role",
    "findAssistantSelection",
    "truncateQuoteSelection",
    "clampSelectionButtonPosition",
    "<SelectionQuoteButton",
    "<OptionChips",
    "onOptionPick",
    "setInput(text)",
    "setQuote(",
    "chat-quote-stack",
    "chat-quote-source",
    "来源 {quoteSource}",
  ]) {
    assert.ok(chat.includes(marker), `预期 Chat.tsx 包含 ${marker}`);
  }

  const selectionButton = read("src/web/src/components/SelectionQuoteButton.tsx");
  for (const marker of [
    "SELECTION_QUOTE_MAX_CHARS = 200",
    "truncateQuoteSelection",
    "clampSelectionButtonPosition",
    "data-selection-quote-button",
    "引用所选",
    "…",
  ]) {
    assert.ok(selectionButton.includes(marker), `预期 SelectionQuoteButton.tsx 包含 ${marker}`);
  }

  const quoteBar = read("src/web/src/components/ChatQuoteBar.tsx");
  for (const marker of ["chat-quote-bar", "引用"]) {
    assert.ok(quoteBar.includes(marker), `预期 ChatQuoteBar.tsx 包含 ${marker}`);
  }
});

test("M10-03 选项 chips 源码：四种序号正则、60 字符上限、多组解析与点击填入输入框", () => {
  const chips = read("src/web/src/components/OptionChips.tsx");
  for (const marker of [
    "OPTION_MAX_CHARS = 60",
    "[A-F]",
    "[1-6]",
    "[①②③④⑤⑥]",
    "（一）（二）（三）",
    "OPTION_PATTERNS",
    "parseOptionGroups",
    "OPTION_MIN_COUNT",
    "OPTION_MAX_COUNT",
    "disabled={isPicked}",
    "onPick(value)",
    "chat-option-chip",
  ]) {
    assert.ok(chips.includes(marker), `预期 OptionChips.tsx 包含 ${marker}`);
  }
});

test("M10-03 构建：pnpm build 退出码 0 且 dist/index.html 存在", { timeout: 240_000 }, () => {
  const buildResult =
    process.platform === "win32"
      ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "pnpm build"], {
          cwd: root,
          stdio: "inherit",
          env: process.env,
        })
      : spawnSync("pnpm", ["build"], {
          cwd: root,
          stdio: "inherit",
          env: process.env,
        });

  assert.equal(
    buildResult.status,
    0,
    `预期 pnpm build 退出码 0，实际 ${String(buildResult.status)}（error=${buildResult.error?.message ?? "none"}）`,
  );
  assert.ok(existsSync(join(root, "dist", "index.html")), "预期 dist/index.html 存在");
});
