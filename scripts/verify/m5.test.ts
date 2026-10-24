import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { runMainTurn, MAIN_SYSTEM_PROMPT } from "../../src/agent/main-loop.ts";
import {
  executeMainTool,
  MAIN_TOOL_SPECS,
  type MainToolOptions,
} from "../../src/agent/main-tools.ts";
import type { LlmToolCall, Task, TaskEvent } from "../../src/core/types.ts";
import { FakeProvider, type FakeStep } from "../../src/providers/fake.ts";
import type { ChatParams, LlmProvider } from "../../src/providers/types.ts";
import { createApp } from "../../src/server/index.ts";
import type { Scheduler } from "../../src/runtime/scheduler.ts";
import { insertArtifact, searchArtifacts } from "../../src/store/artifacts.ts";
import { appendEvent, listEvents } from "../../src/store/events.ts";
import { recallFacts } from "../../src/store/facts.ts";
import { listRecentMessages } from "../../src/store/messages.ts";
import { openDatabase } from "../../src/store/migrate.ts";
import {
  finishRun,
  getTask,
  insertRun,
  insertTask,
  listTasks,
  updateTaskStatus,
} from "../../src/store/repo.ts";

// ── 夹具 ─────────────────────────────────────────────────────────

interface Fixture {
  base: string;
  workspace: string;
  db: DatabaseSync;
}

async function withFixture(fn: (fixture: Fixture) => Promise<void>): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), "task-terminal-m5-"));
  const workspace = join(base, "ws");
  mkdirSync(workspace);
  const db = openDatabase(":memory:");
  try {
    await fn({ base, workspace, db });
  } finally {
    db.close();
    rmSync(base, { recursive: true, force: true });
  }
}

function loopCall(id: string, name: string, args: unknown): LlmToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function toolStep(id: string, name: string, args: unknown, content?: string): FakeStep {
  return {
    content: content ?? null,
    toolCalls: [loopCall(id, name, args)],
  };
}

function eventPayload(event: TaskEvent | undefined): Record<string, unknown> {
  assert.ok(event !== undefined, "期望事件存在");
  assert.ok(
    event.payload !== null && typeof event.payload === "object" && !Array.isArray(event.payload),
  );
  return event.payload as Record<string, unknown>;
}

function taskEvents(fixture: Fixture, taskId: string): TaskEvent[] {
  return listEvents(fixture.db, { taskId, limit: 1_000 });
}

function usageOf(inputTokens: number, cachedTokens: number, outputTokens: number) {
  return { inputTokens, cachedTokens, outputTokens, estimated: false };
}

// ════════════════════════════════════════════════════════════════
// 验收 1：create_task 派活
// ════════════════════════════════════════════════════════════════

test("M5-01 create_task：假 provider 一次工具调用 → 任务 queued、created actor=main、唤醒回调被调", async () => {
  await withFixture(async (fixture) => {
    const provider = new FakeProvider([
      toolStep("call_create", "create_task", {
        title: "整理 CSV",
        goal: "把 workspace/report 里的 CSV 整理成月度分析",
        permission: "workspace-write",
      }),
      { content: "已派活，执行完成后向你汇报。" },
    ]);
    const created: Task[] = [];

    const result = await runMainTurn({
      db: fixture.db,
      provider,
      userMessage: "把 workspace/report 里的 CSV 整理成月度分析",
      workspace: fixture.workspace,
      onTaskCreated: (task) => {
        created.push(task);
      },
    });

    assert.equal(result.reply, "已派活，执行完成后向你汇报。");
    assert.equal(provider.calls.length, 2);
    assert.equal(result.toolTrace.length, 1);
    assert.equal(result.toolTrace[0]?.tool, "create_task");
    assert.equal(result.toolTrace[0]?.ok, true);

    const tasks = listTasks(fixture.db);
    assert.equal(tasks.length, 1);
    const task = tasks[0];
    assert.ok(task !== undefined);
    assert.equal(task.status, "queued");
    assert.equal(task.title, "整理 CSV");
    assert.equal(task.workspace, fixture.workspace);
    assert.equal(task.permission, "workspace-write");

    // onTaskCreated 是调度唤醒的唯一入口：必须在 runMainTurn 返回前被调用。
    assert.equal(created.length, 1);
    assert.equal(created[0]?.id, task.id);

    const events = taskEvents(fixture, task.id);
    assert.deepEqual(
      events.map((event) => event.type),
      ["task.created", "task.queued"],
    );
    const createdEvent = events.find((event) => event.type === "task.created");
    assert.equal(createdEvent?.actor, "main");
    assert.deepEqual(eventPayload(createdEvent), {
      title: task.title,
      goal: task.goal,
      permission: task.permission,
    });
    assert.equal(events.find((event) => event.type === "task.queued")?.actor, "system");
  });
});

// ════════════════════════════════════════════════════════════════
// 验收 2：对话往返 + llm_calls
// ════════════════════════════════════════════════════════════════

test("M5-01 对话往返：user/assistant 落 messages（task_id NULL、seq 递增），llm_calls 逐调用真值", async () => {
  await withFixture(async (fixture) => {
    const provider = new FakeProvider([
      {
        content: "你好，我是任务台主控。",
        usage: usageOf(11, 2, 7),
      },
    ]);

    const result = await runMainTurn({
      db: fixture.db,
      provider,
      userMessage: "你好",
      workspace: fixture.workspace,
    });

    assert.equal(result.reply, "你好，我是任务台主控。");
    assert.deepEqual(result.usage, {
      inputTokens: 11,
      cachedTokens: 2,
      outputTokens: 7,
      totalTokens: 18,
    });

    const messages = listRecentMessages(fixture.db, 10);
    assert.equal(messages.length, 2);
    assert.deepEqual(
      messages.map((message) => message.role),
      ["user", "assistant"],
    );
    assert.deepEqual(
      messages.map((message) => message.seq),
      [1, 2],
    );
    assert.equal(messages[0]?.taskId, null);
    assert.equal(messages[1]?.taskId, null);
    assert.equal(messages[0]?.content, "你好");
    assert.equal(messages[1]?.content, "你好，我是任务台主控。");
    assert.equal(messages[1]?.tokens, 7);

    // content 按 SPEC 落 JSON 文本。
    const rawRows = fixture.db
      .prepare("SELECT content FROM messages WHERE task_id IS NULL ORDER BY seq ASC")
      .all() as unknown as Array<{ content: string }>;
    assert.equal(rawRows.length, 2);
    assert.equal(JSON.parse(rawRows[0]?.content ?? "null"), "你好");

    const calls = fixture.db
      .prepare("SELECT * FROM llm_calls WHERE purpose = 'main' ORDER BY ts ASC")
      .all() as unknown as Array<{
      task_id: string | null;
      run_id: string | null;
      purpose: string;
      model: string;
      input_tokens: number;
      cached_tokens: number;
      output_tokens: number;
      estimated: number;
    }>;
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.ok(call !== undefined);
    assert.equal(call.task_id, null);
    assert.equal(call.run_id, null);
    assert.equal(call.purpose, "main");
    assert.equal(call.model, "deepseek-chat");
    assert.equal(call.input_tokens, 11);
    assert.equal(call.cached_tokens, 2);
    assert.equal(call.output_tokens, 7);
    assert.equal(call.estimated, 0);

    const llmEvents = listEvents(fixture.db, { limit: 100 }).filter(
      (event) => event.type === "llm.call",
    );
    assert.equal(llmEvents.length, 1);
    assert.deepEqual(eventPayload(llmEvents[0]), {
      model: "deepseek-chat",
      in: 11,
      cached: 2,
      out: 7,
      ms: eventPayload(llmEvents[0]).ms,
    });

    // 系统提示必须含附录 B 的 5 条规则。
    const system = provider.calls[0]?.messages[0];
    assert.equal(system?.role, "system");
    assert.equal(system?.content, MAIN_SYSTEM_PROMPT);
    for (const rule of ["1.", "2.", "3.", "4.", "5."]) {
      assert.ok(MAIN_SYSTEM_PROMPT.includes(rule), `系统提示缺少规则 ${rule}`);
    }
  });
});

// ════════════════════════════════════════════════════════════════
// 验收 3：remember → recall 闭环 / supersede
// ════════════════════════════════════════════════════════════════

test("M5-01 remember→recall：同 key 新值取代旧值，recall 只命中当前有效记录", async () => {
  await withFixture(async (fixture) => {
    const first = new FakeProvider([
      toolStep("call_remember_1", "remember", {
        key: "user.timezone",
        value: "Asia/Shanghai",
        scope: "global",
      }),
      toolStep("call_recall_1", "recall", { query: "timezone" }),
      { content: "记住了你的时区。" },
    ]);
    const firstResult = await runMainTurn({
      db: fixture.db,
      provider: first,
      userMessage: "我平时用上海时区",
      workspace: fixture.workspace,
    });
    assert.equal(firstResult.reply, "记住了你的时区。");
    assert.deepEqual(
      firstResult.toolTrace.map((entry) => entry.tool),
      ["remember", "recall"],
    );

    // 第二次 provider 调用的最后一条 tool 消息就是 recall 的返回值。
    const firstRecallMessage = first.calls[2]?.messages.at(-1);
    assert.equal(firstRecallMessage?.role, "tool");
    assert.match(firstRecallMessage?.content ?? "", /Asia\/Shanghai/u);

    const current = recallFacts(fixture.db, { query: "timezone" });
    assert.equal(current.length, 1);
    assert.equal(current[0]?.value, "Asia/Shanghai");

    const second = new FakeProvider([
      toolStep("call_remember_2", "remember", {
        key: "user.timezone",
        value: "UTC",
        scope: "global",
      }),
      toolStep("call_recall_2", "recall", { query: "timezone" }),
      { content: "已更新你的时区。" },
    ]);
    await runMainTurn({
      db: fixture.db,
      provider: second,
      userMessage: "改成 UTC",
      workspace: fixture.workspace,
    });

    const secondRecallMessage = second.calls[2]?.messages.at(-1);
    assert.equal(secondRecallMessage?.role, "tool");
    assert.match(secondRecallMessage?.content ?? "", /UTC/u);
    assert.doesNotMatch(secondRecallMessage?.content ?? "", /Asia\/Shanghai/u);

    const rows = fixture.db
      .prepare("SELECT * FROM memory_facts ORDER BY rowid ASC")
      .all() as unknown as Array<{
      id: string;
      value: string;
      superseded_by: string | null;
      confidence: number;
    }>;
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.value, "Asia/Shanghai");
    assert.equal(rows[1]?.value, "UTC");
    assert.equal(rows[0]?.superseded_by, rows[1]?.id, "旧记录必须指向新记录");
    assert.equal(rows[1]?.superseded_by, null, "新记录必须是当前有效记录");
    assert.equal(rows[0]?.confidence, 0.6);
    assert.equal(rows[1]?.confidence, 0.6);

    const recalled = recallFacts(fixture.db, { query: "" });
    assert.equal(recalled.length, 1);
    assert.equal(recalled[0]?.value, "UTC");

    const memoryEvents = listEvents(fixture.db, { limit: 1_000 }).filter(
      (event) => event.type === "memory.fact_upserted",
    );
    assert.equal(memoryEvents.length, 2);
    assert.equal(memoryEvents[0]?.actor, "main");
    assert.deepEqual(eventPayload(memoryEvents[0]), {
      key: "user.timezone",
      value: "Asia/Shanghai",
    });
  });
});

// ════════════════════════════════════════════════════════════════
// 验收 4：多轮工具循环 + 工具失败回喂
// ════════════════════════════════════════════════════════════════

test("M5-01 多轮工具循环：create_task → get_task → 失败回喂 → 最终文本", async () => {
  await withFixture(async (fixture) => {
    const calls: ChatParams[] = [];
    let callNo = 0;
    // 动态 provider：create_task 的 task_id 只有工具执行后才知道，因此第 2 次
    // chat 时再从库里取任务 id，模拟模型看到工具结果后调整下一步。
    const provider: LlmProvider = {
      chat: async (params) => {
        calls.push(params);
        callNo += 1;
        if (callNo === 1) {
          return {
            content: null,
            toolCalls: [
              loopCall("call_create_multi", "create_task", {
                title: "多轮剧本",
                goal: "验证 create/get/失败回喂",
              }),
            ],
            usage: usageOf(10, 0, 5),
            finishReason: "tool_calls",
          };
        }
        if (callNo === 2) {
          const task = listTasks(fixture.db)[0];
          assert.ok(task !== undefined, "create_task 必须先落库");
          return {
            content: null,
            toolCalls: [loopCall("call_get", "get_task", { task_id: task.id })],
            usage: usageOf(20, 0, 6),
            finishReason: "tool_calls",
          };
        }
        if (callNo === 3) {
          return {
            content: null,
            toolCalls: [loopCall("call_cancel_missing", "cancel_task", { task_id: "t_missing" })],
            usage: usageOf(30, 0, 7),
            finishReason: "tool_calls",
          };
        }
        return {
          content: "任务已创建；取消失败已确认，继续等待执行。",
          toolCalls: [],
          usage: usageOf(40, 0, 8),
          finishReason: "stop",
        };
      },
      stream: async function* () {
        throw new Error("stream not used");
      },
    };

    const result = await runMainTurn({
      db: fixture.db,
      provider,
      userMessage: "跑一遍多轮剧本",
      workspace: fixture.workspace,
      onTaskCreated: () => undefined,
    });

    assert.equal(result.reply, "任务已创建；取消失败已确认，继续等待执行。");
    assert.deepEqual(
      result.toolTrace.map((entry) => entry.tool),
      ["create_task", "get_task", "cancel_task"],
    );
    assert.deepEqual(
      result.toolTrace.map((entry) => entry.ok),
      [true, true, false],
    );
    assert.equal(result.toolTrace[2]?.code, "E_NOT_FOUND");
    assert.equal(calls.length, 4);

    // get_task 的返回值包含最近事件摘要。
    const getTaskToolMessage = calls[2]?.messages.at(-1);
    assert.match(getTaskToolMessage?.content ?? "", /recent_events/u);

    // 失败的 cancel_task 已回喂给模型，下一轮仍继续而不是抛错。
    const beforeFinal = calls[3]?.messages.at(-1);
    assert.equal(beforeFinal?.role, "tool");
    assert.match(beforeFinal?.content ?? "", /任务不存在/u);
    assert.equal(listTasks(fixture.db).length, 1);
  });
});

// ════════════════════════════════════════════════════════════════
// 验收 5：工具轮上限
// ════════════════════════════════════════════════════════════════

test("M5-01 maxToolRounds=2 + 无限工具剧本：返回上限标注，不抛错，只执行 2 轮", async () => {
  await withFixture(async (fixture) => {
    const provider = new FakeProvider([
      toolStep("call_loop_1", "list_tasks", {}, "第 1 轮"),
      toolStep("call_loop_2", "list_tasks", {}, "第 2 轮"),
      toolStep("call_loop_3", "list_tasks", {}, "第 3 轮"),
      toolStep("call_loop_4", "list_tasks", {}, "第 4 轮"),
    ]);

    const result = await runMainTurn({
      db: fixture.db,
      provider,
      userMessage: "无限工具",
      workspace: fixture.workspace,
      maxToolRounds: 2,
    });

    assert.match(result.reply, /\[已达工具轮上限\]/u);
    assert.match(result.reply, /第 1 轮/u);
    assert.match(result.reply, /第 2 轮/u);
    assert.doesNotMatch(result.reply, /第 3 轮/u, "达到上限后不得再消费下一次响应");
    assert.equal(result.toolTrace.length, 2, "只允许执行 2 轮工具");
    assert.equal(provider.calls.length, 2, "执行满 2 轮后不得再发 provider 调用");
    assert.equal(provider.pending, 2, "上限后不得继续消费剧本");

    const messages = listRecentMessages(fixture.db, 10);
    assert.equal(messages.at(-1)?.role, "assistant");
    assert.match(messages.at(-1)?.content ?? "", /\[已达工具轮上限\]/u);
  });
});

// ════════════════════════════════════════════════════════════════
// ask_user 主线语义
// ════════════════════════════════════════════════════════════════

test("M5-01 ask_user：直接作为本轮回复，不建任务 / 不转 waiting_input", async () => {
  await withFixture(async (fixture) => {
    const question = "要整理哪个目录？";
    const provider = new FakeProvider([
      toolStep("call_ask", "ask_user", { question }),
    ]);

    const result = await runMainTurn({
      db: fixture.db,
      provider,
      userMessage: "帮我整理一下",
      workspace: fixture.workspace,
    });

    assert.equal(result.reply, `需要向用户澄清：${question}`);
    assert.equal(provider.calls.length, 1, "ask_user 后不得再叫模型");
    assert.equal(result.toolTrace.length, 1);
    assert.equal(result.toolTrace[0]?.decision, "ask_user_direct_reply");
    assert.equal(listTasks(fixture.db).length, 0, "ask_user 不得建任务");

    const messages = listRecentMessages(fixture.db, 10);
    assert.equal(messages.at(-1)?.role, "assistant");
    assert.equal(messages.at(-1)?.content, `需要向用户澄清：${question}`);
  });
});

// ════════════════════════════════════════════════════════════════
// 验收 6：ops 抽取后 server 行为不变（inject 冒烟）
// ════════════════════════════════════════════════════════════════

function stubScheduler(): {
  scheduler: Scheduler;
  ticks: number[];
  cancelled: string[];
} {
  const ticks: number[] = [];
  const cancelled: string[] = [];
  const scheduler: Scheduler = {
    tick: async () => {
      ticks.push(Date.now());
      return { started: false, reason: "empty" };
    },
    runAll: async () => [],
    shutdown: async () => undefined,
    cancel: (taskId) => {
      cancelled.push(taskId);
      return true;
    },
  };
  return { scheduler, ticks, cancelled };
}

test("M5-01 ops 重构：POST /tasks / cancel / retry 各一条 inject 冒烟，事件与唤醒行为不变", async () => {
  await withFixture(async (fixture) => {
    const { scheduler, ticks, cancelled } = stubScheduler();
    const app = createApp({
      db: fixture.db,
      scheduler,
      defaultWorkspace: fixture.workspace,
    });
    try {
      // POST /tasks：创建事件 actor=user，201 后唤醒调度。
      const createResponse = await app.inject({
        method: "POST",
        url: "/tasks",
        payload: { title: "注入创建", goal: "ops create 冒烟" },
      });
      assert.equal(createResponse.statusCode, 201);
      const createBody = createResponse.json() as Record<string, unknown>;
      assert.equal(createBody.status, "queued");
      const createdId = String(createBody.id);
      assert.equal(ticks.length, 1, "POST /tasks 后必须唤醒调度");
      const createEvents = taskEvents(fixture, createdId);
      assert.deepEqual(
        createEvents.map((event) => event.type),
        ["task.created", "task.queued"],
      );
      assert.equal(createEvents[0]?.actor, "user");

      // cancel：running → cancelled，事件 actor=user，scheduler.cancel 被调。
      const running = insertTask(fixture.db, {
        title: "待取消",
        goal: "ops cancel 冒烟",
        workspace: fixture.workspace,
      });
      updateTaskStatus(fixture.db, running.id, "running");
      const cancelResponse = await app.inject({
        method: "POST",
        url: `/tasks/${running.id}/cancel`,
        payload: { reason: "冒烟取消" },
      });
      assert.equal(cancelResponse.statusCode, 200);
      const cancelledBody = cancelResponse.json() as Record<string, unknown>;
      assert.equal(cancelledBody.status, "cancelled");
      assert.deepEqual(cancelled, [running.id]);
      const cancelEvents = taskEvents(fixture, running.id);
      const cancelledEvent = cancelEvents.at(-1);
      assert.equal(cancelledEvent?.type, "task.cancelled");
      assert.equal(cancelledEvent?.actor, "user");
      assert.deepEqual(eventPayload(cancelledEvent), { reason: "冒烟取消" });

      // retry：failed → queued，事件 system，wakeScheduler 被调。
      const failed = insertTask(fixture.db, {
        title: "待重试",
        goal: "ops retry 冒烟",
        workspace: fixture.workspace,
      });
      updateTaskStatus(fixture.db, failed.id, "running");
      const run = insertRun(fixture.db, { taskId: failed.id, attempt: 1 });
      finishRun(fixture.db, run.id, "failed");
      updateTaskStatus(fixture.db, failed.id, "failed");
      const retryResponse = await app.inject({
        method: "POST",
        url: `/tasks/${failed.id}/retry`,
        payload: {},
      });
      assert.equal(retryResponse.statusCode, 200);
      const retriedBody = retryResponse.json() as Record<string, unknown>;
      assert.equal(retriedBody.status, "queued");
      assert.equal(ticks.length, 2, "retry 后必须唤醒调度");
      const retryEvents = taskEvents(fixture, failed.id);
      const queuedEvent = retryEvents.at(-1);
      assert.equal(queuedEvent?.type, "task.queued");
      assert.equal(queuedEvent?.actor, "system");

      // 冲突路径仍由 ops 统一返回 409。
      const conflictResponse = await app.inject({
        method: "POST",
        url: `/tasks/${failed.id}/cancel`,
        payload: {},
      });
      assert.equal(conflictResponse.statusCode, 409);
      const errorBody = conflictResponse.json() as {
        error: { code: string; message: string };
      };
      assert.equal(errorBody.error.code, "E_CONFLICT");
      assert.match(errorBody.error.message, /queued/u);
    } finally {
      await app.close();
    }
  });
});

// ════════════════════════════════════════════════════════════════
// 验收 7：主线源文件无文件/命令 IO + 十件套 + read_artifact 分页
// ════════════════════════════════════════════════════════════════

test("M5-01 main-tools / main-loop 不 import 文件或子进程模块，十件套齐全", () => {
  const paths = [
    join(process.cwd(), "src", "agent", "main-tools.ts"),
    join(process.cwd(), "src", "agent", "main-loop.ts"),
  ];
  for (const file of paths) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /node:(?:fs|child_process)/u, `${file} 不得引用文件/子进程模块`);
    assert.doesNotMatch(
      source,
      /\brequire\s*\(\s*["'](?:node:)?(?:fs|child_process)/u,
      `${file} 不得 require 文件/子进程模块`,
    );
  }

  const names = MAIN_TOOL_SPECS.map((spec) => spec.name).sort();
  assert.deepEqual(names, [
    "ask_user",
    "cancel_task",
    "create_task",
    "get_task",
    "list_tasks",
    "read_artifact",
    "recall",
    "remember",
    "retry_task",
    "search_artifacts",
  ]);
  for (const spec of MAIN_TOOL_SPECS) {
    assert.equal(typeof spec.description, "string");
    assert.ok(spec.description.length > 0);
    assert.equal(typeof spec.parameters, "object");
  }
});

test("M5-01 read_artifact 分页参数：默认 limit=2000，M7 前正文为空", async () => {
  await withFixture(async (fixture) => {
    const task = insertTask(fixture.db, {
      title: "产物任务",
      goal: "read_artifact 分页",
      workspace: fixture.workspace,
    });
    const artifact = insertArtifact(fixture.db, {
      taskId: task.id,
      kind: "note",
      title: "月度分析",
      summary: "环比上升 12%",
    });
    const options: MainToolOptions = { db: fixture.db, workspace: fixture.workspace };

    const defaultPage = await executeMainTool(
      "read_artifact",
      { artifact_id: artifact.id },
      options,
    );
    assert.equal(defaultPage.ok, true);
    const defaultData = defaultPage.data as Record<string, unknown>;
    assert.equal(defaultData.limit, 2000);
    assert.equal(defaultData.content, "");
    assert.equal(defaultData.offset, 0);

    const explicitPage = await executeMainTool(
      "read_artifact",
      { artifact_id: artifact.id, offset: 5, limit: 10 },
      options,
    );
    assert.equal(explicitPage.ok, true);
    const explicitData = explicitPage.data as Record<string, unknown>;
    assert.equal(explicitData.limit, 10);
    assert.equal(explicitData.content, "");

    const missing = await executeMainTool(
      "read_artifact",
      { artifact_id: "a_missing" },
      options,
    );
    assert.equal(missing.ok, false);
    assert.equal(missing.error?.code, "E_NOT_FOUND");

    // search_artifacts 走既有 FTS 仓储，中文摘要可命中。
    const hits = searchArtifacts(fixture.db, { query: "环比", limit: 5 });
    assert.equal(hits.length, 1);
    const searched = await executeMainTool(
      "search_artifacts",
      { query: "环比", limit: 5 },
      options,
    );
    assert.equal(searched.ok, true);
    assert.match(searched.output, /月度分析/u);
  });
});
