/**
 * M7-01 产物落盘与检索验收。
 *
 * 不访问网络、不读 .env：全部用临时工作区 + 内存库 + FakeProvider；
 * note 文件写到测试注入的临时 artifactsDir，退出时随 base 一起删除。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { persistArtifacts } from "../../src/agent/artifacts.ts";
import { executeMainTool, type MainToolOptions } from "../../src/agent/main-tools.ts";
import type { SubmitResult } from "../../src/agent/result-validator.ts";
import { ContractError, ERROR_CODES } from "../../src/core/errors.ts";
import { foldEvents } from "../../src/core/fold.ts";
import type { LlmToolCall, Task, TaskEvent } from "../../src/core/types.ts";
import { FakeProvider, type FakeStep } from "../../src/providers/fake.ts";
import { runGuardedLoop, type GuardedLoopTask } from "../../src/runtime/watchdog.ts";
import { insertArtifact } from "../../src/store/artifacts.ts";
import { appendEvent, listEvents } from "../../src/store/events.ts";
import { openDatabase } from "../../src/store/migrate.ts";
import { insertTask } from "../../src/store/repo.ts";
import { searchArtifactsRanked } from "../../src/store/search.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const FIXED_NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const RUN_ID = "r_m7";

interface Fixture {
  base: string;
  workspace: string;
  artifactsDir: string;
  db: DatabaseSync;
}

async function withFixture(fn: (fixture: Fixture) => Promise<void>): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), "task-terminal-m7-"));
  const workspace = join(base, "ws");
  const artifactsDir = join(base, "artifact-store");
  mkdirSync(workspace);
  const db = openDatabase(":memory:");
  try {
    await fn({ base, workspace, artifactsDir, db });
  } finally {
    db.close();
    rmSync(base, { recursive: true, force: true });
  }
}

function makeTask(fixture: Fixture): Task {
  const task = insertTask(fixture.db, {
    title: "M7 产物任务",
    goal: "产出报告并提交结论",
    workspace: fixture.workspace,
    permission: "workspace-write",
    now: FIXED_NOW,
  });
  appendEvent(fixture.db, {
    taskId: task.id,
    type: "task.created",
    actor: "user",
    payload: { title: task.title, goal: task.goal, permission: task.permission },
    ts: FIXED_NOW,
  });
  appendEvent(fixture.db, {
    taskId: task.id,
    type: "task.started",
    actor: "system",
    payload: { run_id: RUN_ID },
    ts: FIXED_NOW,
  });
  return task;
}

function toLoopTask(task: Task): GuardedLoopTask {
  return {
    id: task.id,
    title: task.title,
    goal: task.goal,
    permission: task.permission,
    workspace: task.workspace,
    budgetTokens: task.budgetTokens,
  };
}

function loopCall(id: string, name: string, args: unknown): LlmToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function taskEvents(fixture: Fixture, taskId: string): TaskEvent[] {
  return listEvents(fixture.db, { taskId, limit: 1_000 });
}

function payloadOf(event: TaskEvent | undefined): Record<string, unknown> {
  assert.ok(event !== undefined, "期望事件存在");
  assert.ok(
    event.payload !== null && typeof event.payload === "object" && !Array.isArray(event.payload),
  );
  return event.payload as Record<string, unknown>;
}

function countType(events: readonly TaskEvent[], type: TaskEvent["type"]): number {
  return events.filter((event) => event.type === type).length;
}

interface ArtifactRow {
  id: string;
  kind: string;
  title: string;
  path: string | null;
  sha256: string | null;
  bytes: number | null;
  summary: string;
  tags: string;
  findings: string;
}

function artifactRows(db: DatabaseSync, taskId: string): ArtifactRow[] {
  return db
    .prepare(
      "SELECT id, kind, title, path, sha256, bytes, summary, tags, findings FROM artifacts WHERE task_id = ? ORDER BY created_at ASC, id ASC",
    )
    .all(taskId) as unknown as ArtifactRow[];
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function noteFileOf(artifactsDir: string, artifactPath: string): string {
  assert.ok(
    artifactPath.startsWith("data/artifacts/"),
    `note path 应存逻辑相对路径 data/artifacts/...，实际 ${artifactPath}`,
  );
  return join(artifactsDir, artifactPath.slice("data/artifacts/".length));
}

// ════════════════════════════════════════════════════════════════
// 1. submit_result → artifacts 落盘 → 事件顺序 → completed
// ════════════════════════════════════════════════════════════════

test("M7-01 全链路：write_file → submit_result 落盘 file+note，事件在 task.completed 之前", async () => {
  await withFixture(async (fixture) => {
    const report = "# 月度报告\n\n营收增长 12%，成本下降 3%。\n";
    const task = makeTask(fixture);
    const loopTask = toLoopTask(task);

    const provider = new FakeProvider([
      {
        toolCalls: [loopCall("call_write", "write_file", { path: "report.md", content: report })],
      },
      {
        toolCalls: [
          loopCall("call_submit", "submit_result", {
            summary: "完成报告并提炼结论",
            findings: ["营收增长 12%", "成本下降 3%"],
            artifacts: [
              {
                kind: "file",
                title: "月度报告",
                path: "report.md",
                summary: "月度经营报告",
                tags: ["财务", "报告"],
              },
              {
                kind: "note",
                title: "结论笔记",
                summary: "营收增长 12%，成本下降 3%",
                tags: ["结论", "财务"],
              },
            ],
          }),
        ],
      },
    ]);

    const outcome = await runGuardedLoop({
      task: loopTask,
      db: fixture.db,
      provider,
      runId: RUN_ID,
      limits: { maxSteps: 10 },
      now: () => FIXED_NOW,
      ctx: { outputDir: join(fixture.base, "outputs") },
      onBeforeComplete: (result) => {
        persistArtifacts(fixture.db, {
          taskId: task.id,
          runId: RUN_ID,
          workspace: fixture.workspace,
          result,
          now: FIXED_NOW,
          artifactsDir: fixture.artifactsDir,
        });
      },
    });

    assert.ok(outcome.status === "completed", `期望 completed，实际 ${outcome.status}`);

    // tasks.result_json 仍是完整 submit_result；artifacts 表 2 行。
    const rows = artifactRows(fixture.db, task.id);
    assert.equal(rows.length, 2, "artifacts 表应有 2 行");

    const fileRow = rows.find((row) => row.kind === "file");
    assert.ok(fileRow !== undefined, "缺少 file 类产物");
    assert.equal(fileRow.path, "report.md");
    assert.equal(fileRow.sha256, sha256File(join(fixture.workspace, "report.md")));
    assert.equal(fileRow.bytes, Buffer.byteLength(report, "utf8"));

    const noteRow = rows.find((row) => row.kind === "note");
    assert.ok(noteRow !== undefined, "缺少 note 类产物");
    assert.ok(noteRow.path !== null && noteRow.path.startsWith("data/artifacts/"));
    const noteFile = noteFileOf(fixture.artifactsDir, noteRow.path as string);
    assert.equal(existsSync(noteFile), true, `note 文件应真实存在：${noteRow.path}`);
    const noteText = readFileSync(noteFile, "utf8");
    assert.ok(noteText.includes("营收增长 12%，成本下降 3%"), "note 应包含 summary");
    assert.ok(noteText.includes("营收增长 12%"), "note 应包含 findings");
    assert.equal(noteRow.sha256, createHash("sha256").update(noteText).digest("hex"));
    assert.equal(noteRow.bytes, Buffer.byteLength(noteText, "utf8"));

    // 事件顺序：submit 的 tool_result 之后恰好两条 artifact.created，
    // 再 summary.generated，最后 task.completed。
    const events = taskEvents(fixture, task.id);
    const submitCallIndex = events.findIndex(
      (event) => event.type === "agent.tool_call" && payloadOf(event).tool === "submit_result",
    );
    assert.ok(submitCallIndex >= 0, "缺少 submit_result 的 tool_call");
    const tailTypes = events.slice(submitCallIndex).map((event) => event.type);
    assert.deepEqual(tailTypes, [
      "agent.tool_call",
      "agent.tool_result",
      "artifact.created",
      "artifact.created",
      "summary.generated",
      "task.completed",
    ]);

    const summaryEvent = events.find((event) => event.type === "summary.generated");
    assert.equal(payloadOf(summaryEvent).artifact_count, 2);

    const created = events.filter((event) => event.type === "artifact.created");
    assert.equal(created.length, 2);
    for (const event of created) {
      const payload = payloadOf(event);
      assert.equal(typeof payload.artifact_id, "string");
      assert.equal(typeof payload.sha256, "string");
      assert.equal(event.actor, "system");
    }

    assert.equal(countType(events, "task.completed"), 1);
    assert.equal(countType(events, "task.failed"), 0);
    assert.equal(foldEvents(events).status, "completed");
  });
});

// ════════════════════════════════════════════════════════════════
// 2. 假完成防御：声称的 file 不存在 → result_invalid，无落盘/无事件
// ════════════════════════════════════════════════════════════════

test("M7-01 假完成：file path 不存在 → task.failed{result_invalid}，无产物行/无 artifact.created", async () => {
  await withFixture(async (fixture) => {
    const task = makeTask(fixture);
    const provider = new FakeProvider([
      {
        toolCalls: [
          loopCall("call_submit_fake", "submit_result", {
            summary: "声称已产出报告",
            findings: ["报告已生成"],
            artifacts: [
              {
                kind: "file",
                title: "不存在的报告",
                path: "不存在.md",
                summary: "模型声称产出",
              },
            ],
          }),
        ],
      },
    ]);

    const outcome = await runGuardedLoop({
      task: toLoopTask(task),
      db: fixture.db,
      provider,
      runId: RUN_ID,
      limits: { maxSteps: 10 },
      now: () => FIXED_NOW,
      ctx: { outputDir: join(fixture.base, "outputs") },
      onBeforeComplete: (result) => {
        persistArtifacts(fixture.db, {
          taskId: task.id,
          runId: RUN_ID,
          workspace: fixture.workspace,
          result,
          now: FIXED_NOW,
          artifactsDir: fixture.artifactsDir,
        });
      },
    });

    assert.ok(outcome.status === "failed", `期望 failed，实际 ${outcome.status}`);
    if (outcome.status !== "failed") return;
    assert.equal(outcome.reason, "result_invalid");
    assert.equal(outcome.error?.code, ERROR_CODES.E_NOT_FOUND);
    assert.ok(
      (outcome.error?.message ?? "").includes(ERROR_CODES.E_NOT_FOUND),
      "错误信息应带 code",
    );

    assert.equal(artifactRows(fixture.db, task.id).length, 0, "失败时不得留下产物行");
    const events = taskEvents(fixture, task.id);
    assert.equal(countType(events, "artifact.created"), 0);
    assert.equal(countType(events, "summary.generated"), 0);
    assert.equal(countType(events, "task.completed"), 0);
    const failed = events.find((event) => event.type === "task.failed");
    assert.equal(payloadOf(failed).reason, "result_invalid");
    assert.equal(payloadOf(failed).error_code, ERROR_CODES.E_NOT_FOUND);
    assert.equal(foldEvents(events).status, "failed");
  });
});

// ════════════════════════════════════════════════════════════════
// 3. 中文检索：title / summary / tags / note findings
// ════════════════════════════════════════════════════════════════

test("M7-01 中文检索：落盘后按中文标题/摘要/标签/note findings 命中", async () => {
  await withFixture(async (fixture) => {
    const task = makeTask(fixture);
    const result: SubmitResult = {
      summary: "季度复盘：营收增长 12%",
      findings: ["营收增长主要来自企业客户", "成本下降 3%"],
      artifacts: [
        {
          kind: "note",
          title: "季度复盘结论",
          summary: "营收增长 12%，成本下降 3%",
          tags: ["财务", "季度复盘"],
        },
      ],
    };
    const [note] = persistArtifacts(fixture.db, {
      taskId: task.id,
      runId: RUN_ID,
      workspace: fixture.workspace,
      result,
      now: FIXED_NOW,
      artifactsDir: fixture.artifactsDir,
    });
    assert.ok(note !== undefined);

    const byTitle = searchArtifactsRanked(fixture.db, {
      query: "季度复盘结论",
      limit: 8,
      now: FIXED_NOW,
    });
    assert.equal(byTitle[0]?.id, note.id, "中文标题应命中");

    const bySummary = searchArtifactsRanked(fixture.db, {
      query: "营收增长",
      limit: 8,
      now: FIXED_NOW,
    });
    assert.ok(
      bySummary.some((hit) => hit.id === note.id),
      "中文摘要应命中",
    );

    const byFindings = searchArtifactsRanked(fixture.db, {
      query: "企业客户",
      limit: 8,
      now: FIXED_NOW,
    });
    assert.ok(
      byFindings.some((hit) => hit.id === note.id),
      "note findings 应被索引",
    );

    // 2 字查询走短词退化路径，也必须命中 tags。
    const byTag = searchArtifactsRanked(fixture.db, {
      query: "财务",
      limit: 8,
      now: FIXED_NOW,
    });
    assert.ok(
      byTag.some((hit) => hit.id === note.id),
      "中文标签应命中",
    );
  });
});

// ════════════════════════════════════════════════════════════════
// 4. 排序：时间衰减 + tag 命中
// ════════════════════════════════════════════════════════════════

test("M7-01 排序：同等相关度下新产物排前；tag 命中加分可观测", async () => {
  await withFixture(async (fixture) => {
    const task = makeTask(fixture);

    const older = insertArtifact(fixture.db, {
      taskId: task.id,
      kind: "note",
      title: "季度报告",
      summary: "季度报告摘要",
      tags: ["季度"],
      now: FIXED_NOW - 20 * DAY_MS,
    });
    const newer = insertArtifact(fixture.db, {
      taskId: task.id,
      kind: "note",
      title: "季度报告",
      summary: "季度报告摘要",
      tags: ["季度"],
      now: FIXED_NOW,
    });

    const timeHits = searchArtifactsRanked(fixture.db, {
      query: "季度报告",
      limit: 8,
      now: FIXED_NOW,
    });
    assert.deepEqual(
      timeHits.map((hit) => hit.id),
      [newer.id, older.id],
      "同等相关度下新产物应排前",
    );
    const newScore = timeHits.find((hit) => hit.id === newer.id)?.score ?? 0;
    const oldScore = timeHits.find((hit) => hit.id === older.id)?.score ?? 0;
    assert.ok(newScore > oldScore, `时间衰减应让新产物分更高：${newScore} vs ${oldScore}`);

    // tag 命中：同样的标题/摘要，仅 tags 不同。
    const tagged = insertArtifact(fixture.db, {
      taskId: task.id,
      kind: "note",
      title: "财务分析报告",
      summary: "财务分析摘要",
      tags: ["财务分析"],
      now: FIXED_NOW,
    });
    const untagged = insertArtifact(fixture.db, {
      taskId: task.id,
      kind: "note",
      title: "财务分析报告",
      summary: "财务分析摘要",
      tags: ["技术分析"],
      now: FIXED_NOW,
    });

    const tagHits = searchArtifactsRanked(fixture.db, {
      query: "财务分析",
      limit: 8,
      now: FIXED_NOW,
    });
    const taggedHit = tagHits.find((hit) => hit.id === tagged.id);
    const untaggedHit = tagHits.find((hit) => hit.id === untagged.id);
    assert.ok(taggedHit !== undefined && untaggedHit !== undefined);
    assert.ok(taggedHit.score > untaggedHit.score, "tag 命中应加分");
    assert.ok(
      tagHits.findIndex((hit) => hit.id === tagged.id) <
        tagHits.findIndex((hit) => hit.id === untagged.id),
      "tag 命中的产物应排前",
    );
  });
});

// ════════════════════════════════════════════════════════════════
// 5. read_artifact 分页与 file 类元数据
// ════════════════════════════════════════════════════════════════

test("M7-01 read_artifact：note 正文 offset/limit 生效；file 类返回 sha256/bytes/path", async () => {
  await withFixture(async (fixture) => {
    const report = "文件正文不直接进 read_artifact";
    writeFileSync(join(fixture.workspace, "report.md"), report, "utf8");
    const task = makeTask(fixture);
    const result: SubmitResult = {
      summary: "交付报告与结论",
      findings: ["营收增长", "成本下降"],
      artifacts: [
        {
          kind: "file",
          title: "报告文件",
          path: "report.md",
          summary: "报告文件摘要",
          tags: ["报告"],
        },
        {
          kind: "note",
          title: "结论笔记",
          summary: "第一段结论",
          tags: ["结论"],
        },
      ],
    };
    const persisted = persistArtifacts(fixture.db, {
      taskId: task.id,
      runId: RUN_ID,
      workspace: fixture.workspace,
      result,
      now: FIXED_NOW,
      artifactsDir: fixture.artifactsDir,
    });
    const note = persisted.find((artifact) => artifact.kind === "note");
    const file = persisted.find((artifact) => artifact.kind === "file");
    assert.ok(note !== undefined && file !== undefined && note.path !== null);

    const noteText = readFileSync(noteFileOf(fixture.artifactsDir, note.path), "utf8");
    const options: MainToolOptions = {
      db: fixture.db,
      workspace: fixture.workspace,
      artifactsDir: fixture.artifactsDir,
    };

    const paged = await executeMainTool(
      "read_artifact",
      { artifact_id: note.id, offset: 3, limit: 5 },
      options,
    );
    assert.equal(paged.ok, true);
    const pagedData = paged.data as Record<string, unknown>;
    assert.equal(pagedData.content, noteText.slice(3, 8));
    assert.equal(pagedData.total_chars, noteText.length);
    assert.equal(pagedData.offset, 3);
    assert.equal(pagedData.limit, 5);
    assert.equal(pagedData.next_offset, 8);
    assert.equal(paged.output, noteText.slice(3, 8));

    const full = await executeMainTool("read_artifact", { artifact_id: note.id }, options);
    assert.equal((full.data as Record<string, unknown>).content, noteText);

    const fileRead = await executeMainTool("read_artifact", { artifact_id: file.id }, options);
    assert.equal(fileRead.ok, true);
    const fileData = fileRead.data as Record<string, unknown>;
    assert.equal(fileData.content, "", "file 类正文由工作区 read_file 读取，不在此返回");
    assert.equal(fileData.sha256, file.sha256);
    assert.equal(fileData.bytes, Buffer.byteLength(report, "utf8"));
    assert.equal(fileData.path, "report.md");
    assert.ok(fileRead.output.includes(String(file.sha256)), "file 类应把元数据回给模型");
  });
});

// ════════════════════════════════════════════════════════════════
// 6. 直接调用 persistArtifacts：空 artifacts 也发 summary.generated
// ════════════════════════════════════════════════════════════════

test("M7-01 空产物：仍写一条 summary.generated{artifact_count:0}", async () => {
  await withFixture(async (fixture) => {
    const task = makeTask(fixture);
    const result: SubmitResult = {
      summary: "没有产物，只有结论",
      findings: ["无需落盘文件"],
      artifacts: [],
    };
    const persisted = persistArtifacts(fixture.db, {
      taskId: task.id,
      runId: RUN_ID,
      workspace: fixture.workspace,
      result,
      now: FIXED_NOW,
      artifactsDir: fixture.artifactsDir,
    });
    assert.equal(persisted.length, 0);
    assert.equal(artifactRows(fixture.db, task.id).length, 0);

    const summaries = taskEvents(fixture, task.id).filter(
      (event) => event.type === "summary.generated",
    );
    assert.equal(summaries.length, 1);
    assert.equal(payloadOf(summaries[0]).artifact_count, 0);
    assert.equal(payloadOf(summaries[0]).summary, result.summary);
  });
});

// ════════════════════════════════════════════════════════════════
// 7. 契约防御：非 note 缺 path 直接失败，不写任何行
// ════════════════════════════════════════════════════════════════

test("M7-01 契约：file 类缺少 path 抛 E_INVALID_ARGUMENT，且无副作用", async () => {
  await withFixture(async (fixture) => {
    const task = makeTask(fixture);
    const result: SubmitResult = {
      summary: "缺少路径",
      findings: [],
      artifacts: [{ kind: "file", title: "无路径文件", summary: "没有 path" }],
    };
    assert.throws(
      () =>
        persistArtifacts(fixture.db, {
          taskId: task.id,
          runId: RUN_ID,
          workspace: fixture.workspace,
          result,
          now: FIXED_NOW,
          artifactsDir: fixture.artifactsDir,
        }),
      (error: unknown) => {
        assert.ok(error instanceof ContractError);
        assert.equal(error.code, ERROR_CODES.E_INVALID_ARGUMENT);
        return true;
      },
    );
    assert.equal(artifactRows(fixture.db, task.id).length, 0);
    assert.equal(
      taskEvents(fixture, task.id).filter((event) => event.type === "artifact.created").length,
      0,
    );
  });
});

test("M7-01 scheduler 接线：调度路径真实落盘产物（Manager 补接线回归）", async () => {
  const { createScheduler } = await import("../../src/runtime/scheduler.ts");
  const ws = mkdtempSync(join(tmpdir(), "m7-sched-"));
  writeFileSync(join(ws, "out.txt"), "scheduler-wired");
  const db = openDatabase(":memory:");
  const outDir = mkdtempSync(join(tmpdir(), "m7-sched-out-"));
  const { FakeProvider } = await import("../../src/providers/fake.ts");
  const submit = {
    content: "done", toolCalls: [{
      id: "c1", type: "function" as const,
      function: { name: "submit_result", arguments: JSON.stringify({
        summary: "两件产物", findings: ["f1"],
        artifacts: [
          { kind: "file", title: "输出文件", summary: "工作区文件", path: "out.txt" },
          { kind: "note", title: "结论笔记", summary: "这是结论", tags: ["结论"] },
        ],
      }) },
    }], finishReason: "tool_calls",
  };
  const provider = new FakeProvider([
    { content: "先写", toolCalls: [{ id: "w1", type: "function" as const, function: { name: "write_file", arguments: JSON.stringify({ path: "out.txt", content: "scheduler-wired" }) } }] },
    submit,
  ]);
  const { insertTask } = await import("../../src/store/repo.ts");
  const { appendEvent } = await import("../../src/store/events.ts");
  const t = insertTask(db, { title: "t", goal: "g", workspace: ws, permission: "workspace-write" });
  appendEvent(db, { taskId: t.id, type: "task.created", actor: "user", payload: { title: "t", goal: "g" } });
  appendEvent(db, { taskId: t.id, type: "task.queued", actor: "system", payload: {} });
  const sched = createScheduler({ db, provider, reapOnStart: false, ctx: { outputDir: outDir } });
  await sched.tick();
  const { getTask } = await import("../../src/store/repo.ts");
  assert.equal(getTask(db, t.id)?.status, "completed", "调度路径任务应完成");
  const rows = db.prepare("SELECT COUNT(*) c FROM artifacts WHERE task_id = ?").get(t.id) as { c: number };
  assert.equal(rows.c, 2, `调度路径应落盘 2 件产物，实际 ${rows.c}`);
  const evTypes = (db.prepare("SELECT type FROM events WHERE task_id=? ORDER BY seq").all(t.id) as { type: string }[]).map(r => r.type);
  assert.ok(evTypes.includes("artifact.created"), "应有 artifact.created 事件");
  assert.ok(evTypes.indexOf("summary.generated") < evTypes.indexOf("task.completed"), "summary.generated 应在 task.completed 之前");
});
