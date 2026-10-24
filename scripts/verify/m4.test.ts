import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";

import { foldEvents } from "../../src/core/fold.ts";
import type { LlmToolCall, Task, TaskEvent } from "../../src/core/types.ts";
import { FakeProvider, type FakeStep } from "../../src/providers/fake.ts";
import { createScheduler, type SchedulerTickResult } from "../../src/runtime/scheduler.ts";
import { reapExpiredRuns } from "../../src/runtime/reaper.ts";
import { createApp, type SseOptions } from "../../src/server/index.ts";
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

/** 进程是否还活着（signal 0 只探测，不发送信号）。 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── HTTP / SSE 测试夹具（M4-02）──────────────────────────────────

interface JsonResponse {
  status: number;
  body: unknown;
}

interface AppHarness {
  app: FastifyInstance;
  baseUrl: string;
}

async function withApp(
  fixture: Fixture,
  scheduler: ReturnType<typeof createScheduler>,
  sse: SseOptions | undefined,
  fn: (harness: AppHarness) => Promise<void>,
): Promise<void> {
  const app = createApp({
    db: fixture.db,
    scheduler,
    defaultWorkspace: fixture.workspace,
    ...(sse === undefined ? {} : { sse }),
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("测试服务器未返回端口");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await fn({ app, baseUrl });
  } finally {
    await app.close();
  }
}

async function requestJson(
  baseUrl: string,
  path: string,
  init?: RequestInit,
): Promise<JsonResponse> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body };
}

async function postJson(baseUrl: string, path: string, body: unknown): Promise<JsonResponse> {
  return requestJson(baseUrl, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function bodyRecord(response: JsonResponse): Record<string, unknown> {
  assert.ok(
    response.body !== null && typeof response.body === "object" && !Array.isArray(response.body),
    `期望 JSON 对象，实际 ${JSON.stringify(response.body)}`,
  );
  return response.body as Record<string, unknown>;
}

function errorOf(response: JsonResponse): { code: string; message: string } {
  const error = bodyRecord(response).error;
  assert.ok(error !== null && typeof error === "object" && !Array.isArray(error));
  const record = error as Record<string, unknown>;
  return { code: String(record.code), message: String(record.message) };
}

async function waitForTaskStatus(
  baseUrl: string,
  id: string,
  status: string,
  timeoutMs = 3_000,
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  for (;;) {
    const response = await requestJson(baseUrl, `/tasks/${encodeURIComponent(id)}`);
    assert.equal(response.status, 200);
    const task = bodyRecord(response).task;
    assert.ok(task !== null && typeof task === "object" && !Array.isArray(task));
    const record = task as Record<string, unknown>;
    if (record.status === status) return record;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`等待任务 ${id} 到 ${status} 超时，当前 ${String(record.status)}`);
    }
    await delay(10);
  }
}

interface SseFrame {
  id: string | null;
  event: string | null;
  data: string | null;
  comment: string | null;
}

function parseSseFrame(raw: string): SseFrame {
  const frame: SseFrame = { id: null, event: null, data: null, comment: null };
  const dataParts: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) {
      frame.comment = line.slice(1).trim();
      continue;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /u, "");
    if (field === "id") frame.id = value;
    else if (field === "event") frame.event = value;
    else if (field === "data") dataParts.push(value);
  }
  if (dataParts.length > 0) frame.data = dataParts.join("\n");
  return frame;
}

type StreamReadResult = Awaited<
  ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>
>;

function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<StreamReadResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("SSE 读取超时")), timeoutMs);
    reader.read().then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

class SseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly controller: AbortController;
  private readonly decoder = new TextDecoder();
  private buffer = "";

  constructor(response: Response, controller: AbortController) {
    assert.ok(response.body !== null, "SSE 响应缺少 body");
    this.reader = response.body.getReader();
    this.controller = controller;
  }

  async next(timeoutMs = 2_000): Promise<SseFrame> {
    for (;;) {
      const index = this.buffer.indexOf("\n\n");
      if (index >= 0) {
        const raw = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 2);
        return parseSseFrame(raw);
      }
      const chunk = await readWithTimeout(this.reader, timeoutMs);
      if (chunk.done === true) throw new Error("SSE 流提前关闭");
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
    }
  }

  async close(): Promise<void> {
    this.controller.abort();
    try {
      await this.reader.cancel();
    } catch {
      // 客户端 abort 后 cancel 可能抛错，忽略。
    }
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

// ════════════════════════════════════════════════════════════════
// M4-02 REST + SSE
// ════════════════════════════════════════════════════════════════

test("M4-02 SSE 断点续传：after=1 先补 seq 2/3 历史，再收实时第 4 条；after=-1 返回 400", async () => {
  await withFixture(async (fixture) => {
    const scheduler = createScheduler({
      db: fixture.db,
      provider: new FakeProvider([]),
      ctx: { outputDir: fixture.outputDir },
      reapOnStart: false,
    });

    await withApp(fixture, scheduler, undefined, async ({ baseUrl }) => {
      const first = appendEvent(fixture.db, {
        type: "task.created",
        actor: "user",
        payload: { title: "SSE 历史", goal: "断点续传" },
      });
      const second = appendEvent(fixture.db, {
        type: "task.queued",
        actor: "system",
        payload: {},
      });
      const third = appendEvent(fixture.db, {
        type: "task.started",
        actor: "system",
        payload: { run_id: "r_sse" },
      });
      assert.deepEqual([first, second, third], [1, 2, 3]);

      const controller = new AbortController();
      const response = await fetch(`${baseUrl}/events?after=1`, {
        signal: controller.signal,
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/u);
      assert.equal(response.headers.get("cache-control"), "no-cache");
      assert.equal(response.headers.get("x-accel-buffering"), "no");

      const reader = new SseReader(response, controller);
      try {
        const frame2 = await reader.next();
        assert.equal(frame2.id, "2");
        assert.equal(frame2.event, "task.queued");
        assert.deepEqual(JSON.parse(frame2.data ?? "null"), {});

        const frame3 = await reader.next();
        assert.equal(frame3.id, "3");
        assert.equal(frame3.event, "task.started");

        const fourth = appendEvent(fixture.db, {
          type: "agent.step",
          actor: "agent",
          payload: { step_no: 1 },
        });
        assert.equal(fourth, 4);
        const frame4 = await reader.next();
        assert.equal(frame4.id, "4");
        assert.equal(frame4.event, "agent.step");
        assert.deepEqual(JSON.parse(frame4.data ?? "null"), { step_no: 1 });
      } finally {
        await reader.close();
      }

      const bad = await requestJson(baseUrl, "/events?after=-1");
      assert.equal(bad.status, 400);
      assert.equal(errorOf(bad).code, "E_INVALID_ARGUMENT");

      const notInteger = await requestJson(baseUrl, "/events?after=1.5");
      assert.equal(notInteger.status, 400);
    });
  });
});

test("M4-02 SSE 心跳与清理：无事件时收到 : ping，断连后轮询停止", async () => {
  await withFixture(async (fixture) => {
    const scheduler = createScheduler({
      db: fixture.db,
      provider: new FakeProvider([]),
      ctx: { outputDir: fixture.outputDir },
      reapOnStart: false,
    });
    let polls = 0;

    await withApp(
      fixture,
      scheduler,
      { pollIntervalMs: 20, heartbeatMs: 50, onPoll: () => (polls += 1) },
      async ({ baseUrl }) => {
        const controller = new AbortController();
        const response = await fetch(`${baseUrl}/events`, { signal: controller.signal });
        assert.equal(response.status, 200);
        const reader = new SseReader(response, controller);
        try {
          const frame = await reader.next(1_000);
          assert.equal(frame.comment, "ping");
        } finally {
          await reader.close();
        }

        await waitFor(() => polls > 0, 1_000);
        await delay(150);
        const afterClose = polls;
        assert.ok(afterClose > 0, "关闭前应发生过轮询");
        await delay(250);
        assert.equal(polls, afterClose, "连接断开后轮询定时器必须停止");
      },
    );
  });
});

test("M4-02 POST /tasks：201 后 tick 真执行，任务 completed、result_json 可读、事件折出 completed", async () => {
  await withFixture(async (fixture) => {
    const provider = new FakeProvider([submitStep("call_rest_e2e", "REST 完成")]);
    const scheduler = createScheduler({
      db: fixture.db,
      provider,
      ctx: { outputDir: fixture.outputDir },
      reapOnStart: false,
    });

    await withApp(fixture, scheduler, undefined, async ({ baseUrl }) => {
      const created = await postJson(baseUrl, "/tasks", {
        title: "REST 任务",
        goal: "通过 REST 创建并执行",
      });
      assert.equal(created.status, 201);
      const task = bodyRecord(created);
      assert.equal(task.status, "queued");
      const id = String(task.id);
      assert.match(id, /^t_/u);

      const completed = await waitForTaskStatus(baseUrl, id, "completed");
      assert.equal(typeof completed.resultJson, "string");
      const resultJson = completed.resultJson as string;
      assert.ok(resultJson.length > 0);

      const runs = listRuns(fixture.db, id);
      assert.equal(runs.length, 1);
      assert.equal(runs[0]?.status, "completed");

      const folded = foldEvents(listEvents(fixture.db, { taskId: id, limit: 1_000 }));
      assert.equal(folded.status, "completed");
      assert.equal(folded.resultJson, resultJson);

      const detail = await requestJson(baseUrl, `/tasks/${id}`);
      assert.equal(detail.status, 200);
      const detailBody = bodyRecord(detail);
      assert.equal((detailBody.task as Record<string, unknown>).status, "completed");
      assert.ok(Array.isArray(detailBody.events));
    });
  });
});

test("M4-02 cancel：真停慢 loop，任务/run 均 cancelled；completed/queued/waiting_input 返回 409", async () => {
  await withFixture(async (fixture) => {
    const provider = new FakeProvider([
      { content: "很慢的步骤", delayMs: 5_000 },
      submitStep("call_after_cancel"),
    ]);
    const scheduler = createScheduler({
      db: fixture.db,
      provider,
      ctx: { outputDir: fixture.outputDir },
      reapOnStart: false,
    });

    await withApp(fixture, scheduler, undefined, async ({ baseUrl }) => {
      const created = await postJson(baseUrl, "/tasks", {
        title: "取消任务",
        goal: "验证真停",
      });
      const id = String(bodyRecord(created).id);
      await waitForTaskStatus(baseUrl, id, "running");

      const startedAt = Date.now();
      const cancelled = await postJson(baseUrl, `/tasks/${id}/cancel`, {
        reason: "测试取消",
      });
      assert.equal(cancelled.status, 200);
      assert.equal(bodyRecord(cancelled).status, "cancelled");

      await waitFor(() => listRuns(fixture.db, id)[0]?.status === "cancelled");
      assert.ok(Date.now() - startedAt < 2_000, "cancel 必须立即中止慢 provider");
      assert.equal(provider.calls[0]?.signal?.aborted, true, "假 provider 必须感知 abort");
      assert.equal(getTask(fixture.db, id)?.status, "cancelled");

      const events = listEvents(fixture.db, { taskId: id, limit: 100 });
      assert.equal(countType(events, "task.cancelled"), 1);
      assert.equal(payloadOf(events.find((event) => event.type === "task.cancelled")).reason, "测试取消");

      const completedTask = insertTask(fixture.db, {
        title: "已完成任务",
        goal: "取消应 409",
        workspace: fixture.workspace,
      });
      updateTaskStatus(fixture.db, completedTask.id, "running");
      updateTaskStatus(fixture.db, completedTask.id, "completed", { resultJson: "{}" });
      const completedCancel = await postJson(
        baseUrl,
        `/tasks/${completedTask.id}/cancel`,
        {},
      );
      assert.equal(completedCancel.status, 409);
      assert.equal(errorOf(completedCancel).code, "E_CONFLICT");
      assert.match(errorOf(completedCancel).message, /completed/u);

      const queuedTask = insertTask(fixture.db, {
        title: "排队任务",
        goal: "取消应 409",
        workspace: fixture.workspace,
      });
      const queuedCancel = await postJson(baseUrl, `/tasks/${queuedTask.id}/cancel`, {});
      assert.equal(queuedCancel.status, 409);
      assert.match(errorOf(queuedCancel).message, /queued/u);

      const waitingTask = insertTask(fixture.db, {
        title: "等待输入任务",
        goal: "取消应 409",
        workspace: fixture.workspace,
      });
      updateTaskStatus(fixture.db, waitingTask.id, "running");
      updateTaskStatus(fixture.db, waitingTask.id, "waiting_input");
      const waitingCancel = await postJson(baseUrl, `/tasks/${waitingTask.id}/cancel`, {});
      assert.equal(waitingCancel.status, 409);
      assert.match(errorOf(waitingCancel).message, /waiting_input/u);
    });
  });
});

test("M4-02 retry：failed→queued 补事件并重跑；runs=3 的 failed 返回 409", async () => {
  await withFixture(async (fixture) => {
    const provider = new FakeProvider([{ error: new Error("provider boom") }]);
    const scheduler = createScheduler({
      db: fixture.db,
      provider,
      ctx: { outputDir: fixture.outputDir },
      reapOnStart: false,
    });

    await withApp(fixture, scheduler, undefined, async ({ baseUrl }) => {
      const created = await postJson(baseUrl, "/tasks", {
        title: "重试任务",
        goal: "第一次失败，第二次成功",
      });
      const id = String(bodyRecord(created).id);
      await waitForTaskStatus(baseUrl, id, "failed");
      assert.equal(listRuns(fixture.db, id).length, 1);
      const queuedBefore = countType(
        listEvents(fixture.db, { taskId: id, limit: 100 }),
        "task.queued",
      );

      provider.push(submitStep("call_rest_retry", "重试完成"));
      const retried = await postJson(baseUrl, `/tasks/${id}/retry`, {});
      assert.equal(retried.status, 200);
      assert.equal(bodyRecord(retried).status, "queued");

      const completed = await waitForTaskStatus(baseUrl, id, "completed");
      assert.equal(typeof completed.resultJson, "string");
      assert.equal(listRuns(fixture.db, id).length, 2);

      const events = listEvents(fixture.db, { taskId: id, limit: 1_000 });
      assert.equal(countType(events, "task.queued"), queuedBefore + 1);
      assert.equal(foldEvents(events).status, "completed");

      const exhausted = insertTask(fixture.db, {
        title: "用尽重试",
        goal: "attempt=3",
        workspace: fixture.workspace,
      });
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const run = insertRun(fixture.db, { taskId: exhausted.id, attempt });
        finishRun(fixture.db, run.id, "failed");
      }
      updateTaskStatus(fixture.db, exhausted.id, "running");
      updateTaskStatus(fixture.db, exhausted.id, "failed");
      const rejected = await postJson(baseUrl, `/tasks/${exhausted.id}/retry`, {});
      assert.equal(rejected.status, 409);
      assert.match(errorOf(rejected).message, /3/u);
      assert.equal(getTask(fixture.db, exhausted.id)?.status, "failed");
    });
  });
});

test("M4-02 参数校验与 404：错误响应统一为 {error:{code,message}}", async () => {
  await withFixture(async (fixture) => {
    const scheduler = createScheduler({
      db: fixture.db,
      provider: new FakeProvider([]),
      ctx: { outputDir: fixture.outputDir },
      reapOnStart: false,
    });

    await withApp(fixture, scheduler, undefined, async ({ baseUrl }) => {
      const emptyTitle = await postJson(baseUrl, "/tasks", { title: "  ", goal: "x" });
      assert.equal(emptyTitle.status, 400);
      assert.equal(errorOf(emptyTitle).code, "E_INVALID_ARGUMENT");

      const missingGoal = await postJson(baseUrl, "/tasks", { title: "标题" });
      assert.equal(missingGoal.status, 400);

      const badPermission = await postJson(baseUrl, "/tasks", {
        title: "标题",
        goal: "x",
        permission: "root",
      });
      assert.equal(badPermission.status, 400);

      const badLimit = await requestJson(baseUrl, "/tasks?limit=abc");
      assert.equal(badLimit.status, 400);
      assert.equal(errorOf(badLimit).code, "E_INVALID_ARGUMENT");

      const zeroLimit = await requestJson(baseUrl, "/tasks?limit=0");
      assert.equal(zeroLimit.status, 400);

      const badStatus = await requestJson(baseUrl, "/tasks?status=done");
      assert.equal(badStatus.status, 400);

      const missingTask = await requestJson(baseUrl, "/tasks/t_missing");
      assert.equal(missingTask.status, 404);
      assert.equal(errorOf(missingTask).code, "E_NOT_FOUND");

      const unknown = await requestJson(baseUrl, "/nope");
      assert.equal(unknown.status, 404);
      assert.equal(errorOf(unknown).code, "E_NOT_FOUND");

      const badArtifacts = await requestJson(baseUrl, "/artifacts?limit=-1");
      assert.equal(badArtifacts.status, 400);

      const list = await requestJson(baseUrl, "/tasks?status=queued&limit=5");
      assert.equal(list.status, 200);
      assert.ok(Array.isArray(list.body));

      const artifacts = await requestJson(baseUrl, "/artifacts?query=test&limit=5");
      assert.equal(artifacts.status, 200);
      // M11-03：/artifacts 响应统一为 {mode,total,items}（契约 2edffcf4）。
      const artifactsBody = artifacts.body as { mode?: string; items?: unknown[] };
      assert.equal(artifactsBody.mode, "search");
      assert.ok(Array.isArray(artifactsBody.items));
    });
  });
});

test("M4-02 cancel 回归：取消后事件流以 task.cancelled 收尾，foldEvents 折出 cancelled", async () => {
  await withFixture(async (fixture) => {
    const provider = new FakeProvider([
      { content: "很慢的步骤", delayMs: 5_000 },
      submitStep("call_after_cancel_fold"),
    ]);
    const scheduler = createScheduler({
      db: fixture.db,
      provider,
      ctx: { outputDir: fixture.outputDir },
      reapOnStart: false,
    });

    await withApp(fixture, scheduler, undefined, async ({ baseUrl }) => {
      const created = await postJson(baseUrl, "/tasks", {
        title: "取消折叠回归",
        goal: "取消后事件流仍可折叠",
      });
      assert.equal(created.status, 201);
      const id = String(bodyRecord(created).id);
      await waitForTaskStatus(baseUrl, id, "running");

      const cancelResponse = await postJson(baseUrl, `/tasks/${id}/cancel`, {
        reason: "折叠回归",
      });
      assert.equal(cancelResponse.status, 200);
      assert.equal(bodyRecord(cancelResponse).status, "cancelled");

      // run 收 cancelled 发生在 loop 返回之后；等到它即代表在跑的 loop 已完全收尾。
      await waitFor(() => listRuns(fixture.db, id)[0]?.status === "cancelled");
      assert.equal(getTask(fixture.db, id)?.status, "cancelled", "任务表必须是 cancelled");

      const events = listEvents(fixture.db, { taskId: id, limit: 1_000 });
      const sequence = events.map((event) => `${event.seq}:${event.type}`).join(" → ");
      const terminalTypes = events
        .filter(
          (event) =>
            event.type === "task.completed" ||
            event.type === "task.failed" ||
            event.type === "task.cancelled",
        )
        .map((event) => event.type);
      assert.deepEqual(
        terminalTypes,
        ["task.cancelled"],
        `终态事件必须恰好一条 task.cancelled，实际事件序列 ${sequence}`,
      );

      const last = events.at(-1);
      assert.ok(last !== undefined);
      assert.equal(last.type, "task.cancelled", `task.cancelled 之后不得再有任何事件：${sequence}`);
      assert.equal(last.actor, "user");
      assert.deepEqual(payloadOf(last), { reason: "折叠回归" });
      assert.equal(
        events.filter((event) => event.seq > last.seq).length,
        0,
        `事件流必须在 task.cancelled 处关闭：${sequence}`,
      );

      const folded = foldEvents(events);
      assert.equal(folded.status, "cancelled", `折叠失败的事件序列：${sequence}`);
      assert.equal(folded.error, "折叠回归");
      assert.equal(folded.lastEventType, "task.cancelled");
    });
  });
});

test("M4-02 cancel 回归：工具执行中取消，事件流仍以 task.cancelled 收尾", async () => {
  await withFixture(async (fixture) => {
    const pidFile = join(fixture.workspace, "tool-child.pid");
    const survivedFile = join(fixture.workspace, "tool-child-survived.txt");
    // 子进程先把 pid 落盘，再阻塞 ~3s；若未被杀，3s 后会写下“存活”标记。
    const script = [
      'const fs = require("node:fs");',
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      `setTimeout(() => fs.writeFileSync(${JSON.stringify(survivedFile)}, "survived"), 3000);`,
    ].join(" ");
    const provider = new FakeProvider([
      {
        toolCalls: [
          loopCall("call_long_tool", "run_command", {
            argv: [process.execPath, "-e", script],
          }),
        ],
      },
      submitStep("call_after_tool_cancel"),
    ]);
    const scheduler = createScheduler({
      db: fixture.db,
      provider,
      ctx: { outputDir: fixture.outputDir },
      reapOnStart: false,
    });

    await withApp(fixture, scheduler, undefined, async ({ baseUrl }) => {
      const created = await postJson(baseUrl, "/tasks", {
        title: "工具执行中取消",
        goal: "长命令执行中取消，事件流必须干净收尾",
        permission: "workspace-write",
      });
      assert.equal(created.status, 201);
      const id = String(bodyRecord(created).id);
      await waitForTaskStatus(baseUrl, id, "running");

      // 等到 agent.tool_call 落库、并确认子进程确实已经启动（pid 文件出现）。
      await waitFor(
        () =>
          listEvents(fixture.db, { taskId: id, limit: 1_000 }).some(
            (event) => event.type === "agent.tool_call",
          ),
        5_000,
      );
      await waitFor(() => existsSync(pidFile), 5_000);
      const childPid = Number(readFileSync(pidFile, "utf8").trim());
      assert.ok(Number.isInteger(childPid) && childPid > 0, "子进程必须写出合法 pid");
      assert.equal(isProcessAlive(childPid), true, "取消前命令进程必须还活着");

      const cancelResponse = await postJson(baseUrl, `/tasks/${id}/cancel`, {
        reason: "工具执行中取消",
      });
      assert.equal(cancelResponse.status, 200);
      assert.equal(bodyRecord(cancelResponse).status, "cancelled");

      // 命令被 abort 杀树后 executeTool 才返回，loop 收尾后 run 才落 cancelled；
      // 等到 run 即代表整条执行链已经结束。
      await waitFor(() => listRuns(fixture.db, id)[0]?.status === "cancelled", 10_000);
      assert.equal(getTask(fixture.db, id)?.status, "cancelled", "任务表必须是 cancelled");

      const events = listEvents(fixture.db, { taskId: id, limit: 1_000 });
      const sequence = events.map((event) => `${event.seq}:${event.type}`).join(" → ");
      const last = events.at(-1);
      assert.ok(last !== undefined);
      assert.equal(last.type, "task.cancelled", `task.cancelled 之后不得再有任何事件：${sequence}`);
      assert.equal(
        events.filter((event) => event.seq > last.seq).length,
        0,
        `事件流必须在 task.cancelled 处关闭：${sequence}`,
      );
      assert.equal(
        countType(events, "task.cancelled"),
        1,
        `终态事件必须恰好一条 task.cancelled：${sequence}`,
      );
      assert.equal(
        countType(events, "agent.tool_result"),
        0,
        `工具中取消后不得补 agent.tool_result（终态守卫跳过是预期）：${sequence}`,
      );
      assert.equal(countType(events, "agent.tool_call"), 1, `必须留下一条工具调用记录：${sequence}`);

      const folded = foldEvents(events);
      assert.equal(folded.status, "cancelled", `折叠失败的事件序列：${sequence}`);
      assert.equal(folded.lastEventType, "task.cancelled");

      const runs = listRuns(fixture.db, id);
      assert.equal(runs.length, 1);
      assert.equal(runs[0]?.status, "cancelled", "run 表必须收 cancelled");

      // 命令进程已被杀：pid 不再存活，且 3s 后的“存活”标记不会出现。
      await waitFor(() => !isProcessAlive(childPid), 3_000);
      assert.equal(isProcessAlive(childPid), false, `取消后命令进程 ${childPid} 必须已被杀`);
      assert.equal(existsSync(survivedFile), false, "命令进程不得活到写存活标记");

      // 事件序列打到 stdout，便于人工核对“缺 tool_result 是预期”。
      console.log(
        `[M4-02 工具中取消] 事件序列：${sequence}；agent.tool_result 缺失为预期（终态守卫跳过），子进程 ${childPid} 已被杀`,
      );
    });
  });
});

