import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { foldEvents } from "../../src/core/fold.ts";
import type { LlmToolCall, Task, TaskEvent } from "../../src/core/types.ts";
import { FakeProvider, type FakeStep } from "../../src/providers/fake.ts";
import { createScheduler, type SchedulerTickResult } from "../../src/runtime/scheduler.ts";
import { reapExpiredRuns } from "../../src/runtime/reaper.ts";
import { appendEvent, listEvents } from "../../src/store/events.ts";
import { insertLlmCall } from "../../src/store/llm-calls.ts";
import { openDatabase } from "../../src/store/migrate.ts";
import {
  finishRun,
  getRun,
  getTask,
  insertRun,
  insertTask,
  listRuns,
  updateTaskStatus,
} from "../../src/store/repo.ts";

// ── 夹具 ─────────────────────────────────────────────────────────

interface Fixture {
  base: string;
  workspace: string;
  outputDir: string;
  db: DatabaseSync;
}

async function withFixture(fn: (fixture: Fixture) => Promise<void>): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), "task-terminal-m4-"));
  const workspace = join(base, "ws");
  const outputDir = join(base, "outputs");
  mkdirSync(workspace);
  const db = openDatabase(":memory:");
  try {
    await fn({ base, workspace, outputDir, db });
  } finally {
    db.close();
    rmSync(base, { recursive: true, force: true });
  }
}

function createQueuedTask(fixture: Fixture, title = "M4 测试任务"): Task {
  const task = insertTask(fixture.db, {
    title,
    goal: "验证调度器与崩溃恢复",
    workspace: fixture.workspace,
  });
  appendEvent(fixture.db, {
    taskId: task.id,
    type: "task.created",
    actor: "user",
    payload: { title: task.title, goal: task.goal, permission: task.permission },
  });
  appendEvent(fixture.db, {
    taskId: task.id,
    type: "task.queued",
    actor: "system",
    payload: {},
  });
  return task;
}

/** 手工伪造“正在跑”的任务与 run（先写 started 事件再改表）。 */
function forceRunning(
  fixture: Fixture,
  task: Task,
  attempt: number,
  leaseUntil: number,
): ReturnType<typeof insertRun> {
  const run = insertRun(fixture.db, {
    taskId: task.id,
    attempt,
    leaseUntil,
    now: leaseUntil - 60_000,
  });
  appendEvent(fixture.db, {
    taskId: task.id,
    runId: run.id,
    type: "task.started",
    actor: "system",
    payload: { run_id: run.id },
  });
  updateTaskStatus(fixture.db, task.id, "running");
  return run;
}

function taskEvents(fixture: Fixture, task: Task): TaskEvent[] {
  return listEvents(fixture.db, { taskId: task.id, limit: 1_000 });
}

function countType(events: readonly TaskEvent[], type: TaskEvent["type"]): number {
  return events.filter((event) => event.type === type).length;
}

function payloadOf(event: TaskEvent | undefined): Record<string, unknown> {
  assert.ok(event !== undefined, "事件不存在");
  assert.ok(
    event.payload !== null && typeof event.payload === "object" && !Array.isArray(event.payload),
  );
  return event.payload as Record<string, unknown>;
}

function loopCall(id: string, name: string, args: unknown): LlmToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function submitStep(callId: string, summary = "完成"): FakeStep {
  return {
    toolCalls: [loopCall(callId, "submit_result", { summary, findings: [], artifacts: [] })],
  };
}

function startedResult(result: SchedulerTickResult): Extract<SchedulerTickResult, { started: true }> {
  assert.equal(result.started, true, `期望 tick 启动任务，实际 ${JSON.stringify(result)}`);
  if (!result.started) throw new Error("unreachable");
  return result;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("waitFor 超时");
    await delay(2);
  }
}

// ════════════════════════════════════════════════════════════════
// 崩溃恢复 / 孤儿 run
// ════════════════════════════════════════════════════════════════

test("M4-01 reaper：过期 running 任务补 failed + queued 事件并回队列（attempt<3）", async () => {
  await withFixture(async (fixture) => {
    const now = Date.UTC(2026, 0, 15, 12, 0, 0);
    const task = createQueuedTask(fixture);
    const run = forceRunning(fixture, task, 1, now - 1);

    const reaped = reapExpiredRuns(fixture.db, now);
    assert.equal(reaped.length, 1);
    assert.equal(reaped[0]?.id, run.id);
    assert.equal(reaped[0]?.status, "interrupted");

    const finished = getRun(fixture.db, run.id);
    assert.ok(finished !== null);
    assert.equal(finished.status, "interrupted");
    assert.ok(finished.endedAt !== null, "run 必须写 ended_at");

    const afterTask = getTask(fixture.db, task.id);
    assert.ok(afterTask !== null);
    assert.equal(afterTask.status, "queued", "attempt<3 必须回队列");

    const events = taskEvents(fixture, task);
    assert.equal(countType(events, "task.failed"), 1);
    assert.equal(payloadOf(events.find((event) => event.type === "task.failed")).reason, "interrupted");
    assert.equal(payloadOf(events.find((event) => event.type === "task.failed")).attempt, 1);
    assert.equal(countType(events, "task.queued"), 2, "首次入队 + 重试回队各一条");

    const failed = events.find((event) => event.type === "task.failed");
    const requeued = events.filter((event) => event.type === "task.queued").at(-1);
    assert.ok(failed !== undefined && requeued !== undefined);
    assert.ok(requeued.seq > failed.seq, "task.queued 必须在 task.failed 之后");

    const folded = foldEvents(events);
    assert.equal(folded.status, "queued");
    assert.equal(folded.attempt, 2, "failed→queued 让 foldEvents 把 attempt 递增到 2");
  });
});

test("M4-01 reaper：attempt=3 用尽只到 failed，不再入队", async () => {
  await withFixture(async (fixture) => {
    const now = Date.UTC(2026, 0, 15, 12, 0, 0);
    const task = createQueuedTask(fixture);
    forceRunning(fixture, task, 3, now - 1);

    const reaped = reapExpiredRuns(fixture.db, now);
    assert.equal(reaped.length, 1);
    assert.equal(reaped[0]?.status, "interrupted");
    assert.equal(getTask(fixture.db, task.id)?.status, "failed");

    const events = taskEvents(fixture, task);
    assert.equal(countType(events, "task.failed"), 1);
    assert.equal(countType(events, "task.queued"), 1, "不得再补 queued 事件");
    const folded = foldEvents(events);
    assert.equal(folded.status, "failed");
    assert.equal(folded.error, "interrupted");
  });
});

test("M4-01 reaper：任务已 completed 的孤儿 run 只收 run，不改任务/不发任务事件", async () => {
  await withFixture(async (fixture) => {
    const now = Date.UTC(2026, 0, 15, 12, 0, 0);
    const task = createQueuedTask(fixture);
    const run = forceRunning(fixture, task, 1, now - 1);

    const resultJson = JSON.stringify({ summary: "已完成", findings: [], artifacts: [] });
    appendEvent(fixture.db, {
      taskId: task.id,
      runId: run.id,
      type: "task.completed",
      actor: "system",
      payload: { result_json: JSON.parse(resultJson) },
    });
    updateTaskStatus(fixture.db, task.id, "completed", { resultJson });
    const before = taskEvents(fixture, task);

    const reaped = reapExpiredRuns(fixture.db, now);
    assert.equal(reaped.length, 1);
    assert.equal(getRun(fixture.db, run.id)?.status, "interrupted");
    assert.equal(getTask(fixture.db, task.id)?.status, "completed");

    const after = taskEvents(fixture, task);
    assert.equal(after.length, before.length, "孤儿 run 不得追加任何任务事件");
    assert.equal(countType(after, "task.failed"), 0);
  });
});

test("M4-01 reaper：租约未到期与已收尾的 run 不动", async () => {
  await withFixture(async (fixture) => {
    const now = Date.UTC(2026, 0, 15, 12, 0, 0);
    const task = createQueuedTask(fixture);
    const run = forceRunning(fixture, task, 1, now + 60_000);

    assert.deepEqual(reapExpiredRuns(fixture.db, now), []);
    assert.equal(getRun(fixture.db, run.id)?.status, "running");
    assert.equal(getTask(fixture.db, task.id)?.status, "running");

    finishRun(fixture.db, run.id, "interrupted", { now });
    const before = taskEvents(fixture, task);
    assert.deepEqual(reapExpiredRuns(fixture.db, now), []);
    assert.equal(taskEvents(fixture, task).length, before.length);
  });
});

// ════════════════════════════════════════════════════════════════
// 调度器主路径
// ════════════════════════════════════════════════════════════════

test("M4-01 端到端：三步假 provider → 任务/run/事件全部 completed 且 result_json 一致", async () => {
  await withFixture(async (fixture) => {
    const task = createQueuedTask(fixture);
    const provider = new FakeProvider([
      { content: "第一步：确认目标" },
      { content: "第二步：整理结论" },
      submitStep("call_e2e", "三步完成"),
    ]);
    const scheduler = createScheduler({
      db: fixture.db,
      provider,
      ctx: { outputDir: fixture.outputDir },
    });

    const result = startedResult(await scheduler.tick());
    assert.equal(result.outcome.status, "completed");
    if (result.outcome.status !== "completed") return;
    assert.equal(result.outcome.result.summary, "三步完成");
    assert.equal(provider.calls.length, 3);

    const saved = getTask(fixture.db, task.id);
    assert.ok(saved !== null);
    assert.equal(saved.status, "completed");
    assert.equal(saved.resultJson, result.outcome.resultJson);

    const runs = listRuns(fixture.db, task.id);
    assert.equal(runs.length, 1);
    const run = runs[0];
    assert.ok(run !== undefined);
    assert.equal(run.id, result.runId);
    assert.equal(run.attempt, 1);
    assert.equal(run.status, "completed");
    assert.equal(run.steps, 3);
    assert.ok(run.endedAt !== null);

    const events = taskEvents(fixture, task);
    assert.equal(countType(events, "task.started"), 1);
    assert.equal(payloadOf(events.find((event) => event.type === "task.started")).run_id, run.id);
    assert.equal(countType(events, "task.completed"), 1);
    assert.equal(countType(events, "task.failed"), 0);

    const folded = foldEvents(events);
    assert.equal(folded.status, "completed");
    assert.deepEqual(JSON.parse(folded.resultJson ?? "null"), JSON.parse(result.outcome.resultJson));
  });
});

test("M4-01 waiting_input：任务表 waiting_input、run interrupted、事件折出 waiting_input", async () => {
  await withFixture(async (fixture) => {
    const task = createQueuedTask(fixture);
    const question = "要把结果写成文件吗？";
    const provider = new FakeProvider([
      { toolCalls: [loopCall("call_ask", "ask_user", { question })] },
    ]);
    const scheduler = createScheduler({
      db: fixture.db,
      provider,
      ctx: { outputDir: fixture.outputDir },
    });

    const result = startedResult(await scheduler.tick());
    assert.equal(result.outcome.status, "waiting_input");
    if (result.outcome.status !== "waiting_input") return;
    assert.equal(result.outcome.question, question);

    assert.equal(getTask(fixture.db, task.id)?.status, "waiting_input");
    const runs = listRuns(fixture.db, task.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.status, "interrupted", "waiting_input 的本次 run 视为中断");

    const events = taskEvents(fixture, task);
    assert.equal(countType(events, "task.failed"), 0, "waiting_input 不是失败，不补 task.failed");
    const folded = foldEvents(events);
    assert.equal(folded.status, "waiting_input");
    assert.equal(folded.pendingQuestion, question);
  });
});

test("M4-01 失败：loop failed{exception} → 任务 failed、run failed；手动重试后 attempt=2 完成", async () => {
  await withFixture(async (fixture) => {
    const task = createQueuedTask(fixture);
    const provider = new FakeProvider([{ error: new Error("provider boom") }]);
    const scheduler = createScheduler({
      db: fixture.db,
      provider,
      ctx: { outputDir: fixture.outputDir },
    });

    const first = startedResult(await scheduler.tick());
    assert.equal(first.outcome.status, "failed");
    if (first.outcome.status !== "failed") return;
    assert.equal(first.outcome.reason, "exception");
    assert.equal(getTask(fixture.db, task.id)?.status, "failed");
    assert.equal(getRun(fixture.db, first.runId)?.status, "failed");
    assert.equal(foldEvents(taskEvents(fixture, task)).status, "failed");

    // 重试入口：事件先写 task.queued，再 failed→queued；新 run 的 attempt = 既有 runs + 1。
    appendEvent(fixture.db, {
      taskId: task.id,
      type: "task.queued",
      actor: "system",
      payload: {},
    });
    updateTaskStatus(fixture.db, task.id, "queued");
    provider.push(submitStep("call_retry", "重试完成"));

    const second = startedResult(await scheduler.tick());
    assert.equal(second.outcome.status, "completed");
    assert.equal(getTask(fixture.db, task.id)?.status, "completed");

    const runs = listRuns(fixture.db, task.id);
    assert.equal(runs.length, 2, "重试必须新建 run，不复活旧 run");
    assert.equal(runs[1]?.attempt, 2);
    assert.equal(runs[1]?.status, "completed");
    assert.equal(foldEvents(taskEvents(fixture, task)).status, "completed");
  });
});

// ════════════════════════════════════════════════════════════════
// 并发 / 预算 / 租约 / 停机
// ════════════════════════════════════════════════════════════════

test("M4-01 并发恒 1：tick 在跑时再次 tick 只 no-op，不产生第二个 run", async () => {
  await withFixture(async (fixture) => {
    const task = createQueuedTask(fixture);
    const provider = new FakeProvider([
      { content: "慢剧本", delayMs: 80 },
      submitStep("call_single"),
    ]);
    const scheduler = createScheduler({
      db: fixture.db,
      provider,
      ctx: { outputDir: fixture.outputDir },
    });

    const first = scheduler.tick();
    const second = await scheduler.tick();
    assert.deepEqual(second, { started: false, reason: "busy" });

    const result = startedResult(await first);
    assert.equal(result.outcome.status, "completed");
    assert.equal(listRuns(fixture.db, task.id).length, 1, "并发 tick 不得启动第二个 run");
    assert.equal(getTask(fixture.db, task.id)?.status, "completed");
  });
});

test("M4-01 日预算 100%：tick 不启动、任务仍 queued、无新事件/run", async () => {
  await withFixture(async (fixture) => {
    const task = createQueuedTask(fixture);
    insertLlmCall(fixture.db, {
      purpose: "agent",
      model: "deepseek-chat",
      inputTokens: 2_000_000,
      outputTokens: 0,
      ts: Date.now(),
    });
    const before = taskEvents(fixture, task);
    const scheduler = createScheduler({
      db: fixture.db,
      provider: new FakeProvider([]),
      ctx: { outputDir: fixture.outputDir },
    });

    const result = await scheduler.tick();
    assert.equal(result.started, false);
    if (result.started) return;
    assert.equal(result.reason, "budget");
    assert.equal(result.gate?.allowed, false);
    assert.equal(result.gate?.spent, 2_000_000);

    assert.equal(getTask(fixture.db, task.id)?.status, "queued");
    assert.equal(listRuns(fixture.db, task.id).length, 0);
    assert.deepEqual(taskEvents(fixture, task), before, "预算拒绝不得追加任何事件");
  });
});

test("M4-01 租约：运行中按间隔续约，结束后定时器不再续约", async () => {
  await withFixture(async (fixture) => {
    const task = createQueuedTask(fixture);
    const provider = new FakeProvider([
      { content: "准备", delayMs: 20 },
      { content: "整理", delayMs: 20 },
      submitStep("call_lease"),
    ]);
    const scheduler = createScheduler({
      db: fixture.db,
      provider,
      ctx: { outputDir: fixture.outputDir },
      leaseMs: 120,
      renewIntervalMs: 10,
    });

    const pending = scheduler.tick();
    const runs = listRuns(fixture.db, task.id);
    const run = runs[0];
    assert.ok(run !== undefined);
    const initialLease = run.leaseUntil;
    await waitFor(() => (getRun(fixture.db, run.id)?.leaseUntil ?? 0) > initialLease);

    const result = startedResult(await pending);
    assert.equal(result.outcome.status, "completed");
    const afterFinish = getRun(fixture.db, run.id);
    assert.ok(afterFinish !== null);
    assert.equal(afterFinish.status, "completed");
    const finalLease = afterFinish.leaseUntil;
    assert.ok(finalLease > initialLease, "运行中必须发生续约");

    await delay(50);
    assert.equal(
      getRun(fixture.db, run.id)?.leaseUntil,
      finalLease,
      "loop 结束后不得再续约",
    );
  });
});

test("M4-01 shutdown(abort)：立即中止按 interrupted 收尾，之后 tick 不再接单", async () => {
  await withFixture(async (fixture) => {
    const task = createQueuedTask(fixture);
    const provider = new FakeProvider([
      { content: "很慢的第一步", delayMs: 500 },
      submitStep("call_abort"),
    ]);
    const scheduler = createScheduler({
      db: fixture.db,
      provider,
      ctx: { outputDir: fixture.outputDir },
    });

    const pending = scheduler.tick();
    const run = listRuns(fixture.db, task.id)[0];
    assert.ok(run !== undefined);

    const stopping = scheduler.shutdown({ abort: true });
    const result = startedResult(await pending);
    await stopping;

    assert.equal(result.outcome.status, "failed");
    if (result.outcome.status !== "failed") return;
    assert.equal(result.outcome.reason, "interrupted");
    assert.equal(getTask(fixture.db, task.id)?.status, "failed");
    assert.equal(getRun(fixture.db, run.id)?.status, "interrupted");
    assert.equal(foldEvents(taskEvents(fixture, task)).status, "failed");

    const after = await scheduler.tick();
    assert.deepEqual(after, { started: false, reason: "shutdown" });
    assert.equal(listRuns(fixture.db, task.id).length, 1);
  });
});

test("M4-01 启动恢复：createScheduler 默认先 reap 过期 run，再调度回队的任务", async () => {
  await withFixture(async (fixture) => {
    const now = Date.UTC(2026, 0, 15, 12, 0, 0);
    const task = createQueuedTask(fixture);
    const stale = forceRunning(fixture, task, 1, now - 1);

    const provider = new FakeProvider([submitStep("call_startup", "启动恢复后完成")]);
    const scheduler = createScheduler({
      db: fixture.db,
      provider,
      ctx: { outputDir: fixture.outputDir },
      now: () => now,
    });

    assert.equal(getRun(fixture.db, stale.id)?.status, "interrupted");
    assert.equal(getTask(fixture.db, task.id)?.status, "queued");
    const recovered = foldEvents(taskEvents(fixture, task));
    assert.equal(recovered.status, "queued");
    assert.equal(recovered.attempt, 2);

    const result = startedResult(await scheduler.tick());
    assert.equal(result.outcome.status, "completed");
    assert.equal(getTask(fixture.db, task.id)?.status, "completed");
    const runs = listRuns(fixture.db, task.id);
    assert.equal(runs.length, 2);
    assert.equal(runs[1]?.attempt, 2);
  });
});
