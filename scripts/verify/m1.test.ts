import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { ContractError, ERROR_CODES } from "../../src/core/errors.ts";
import { foldEvents } from "../../src/core/fold.ts";
import type { EventActor, EventType, JsonValue, TaskEvent } from "../../src/core/types.ts";
import { getArtifact, insertArtifact, searchArtifacts, updateArtifactSummary } from "../../src/store/artifacts.ts";
import { migrate, openDatabase } from "../../src/store/migrate.ts";
import { appendEvent, listEvents } from "../../src/store/events.ts";
import { insertTask } from "../../src/store/repo.ts";
import {
  appendEvent as appendEventFromRepo,
  listEvents as listEventsFromRepo,
} from "../../src/store/repo.ts";

const root = join(import.meta.dirname, "..", "..");
const read = (p: string): string => readFileSync(join(root, p), "utf8");

interface EventSpec {
  type: EventType;
  payload?: JsonValue;
  actor?: EventActor;
  taskId?: string | null;
  runId?: string | null;
  ts?: number;
}

function makeEvents(specs: EventSpec[]): TaskEvent[] {
  return specs.map((spec, index) => ({
    seq: index + 1,
    taskId: spec.taskId === undefined ? "t_test" : spec.taskId,
    runId: spec.runId ?? null,
    ts: spec.ts ?? 1000 + index * 100,
    type: spec.type,
    actor: spec.actor ?? "system",
    payload: spec.payload ?? {},
  }));
}

function isInvalidTransition(err: unknown): boolean {
  assert.ok(err instanceof ContractError, `期望 ContractError，实际 ${String(err)}`);
  assert.equal(err.code, ERROR_CODES.E_INVALID_TRANSITION, "错误码应为 E_INVALID_TRANSITION");
  return true;
}

function withTempDb<T>(fn: (db: DatabaseSync) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "task-terminal-m1-"));
  const file = join(dir, "test.db");
  const db = openDatabase(file);
  try {
    return fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("M1-01 六条事件折出 completed", () => {
  const events = makeEvents([
    {
      type: "task.created",
      actor: "user",
      payload: { title: "月度分析", goal: "整理 CSV", permission: "workspace-write" },
    },
    { type: "task.queued", payload: { run_id: "r_1" } },
    { type: "task.started", payload: { run_id: "r_1" } },
    { type: "agent.step", actor: "agent", payload: { step_no: 1 } },
    { type: "agent.step", actor: "agent", payload: { step_no: 2 } },
    { type: "task.completed", payload: { result_json: '{"summary":"ok"}' } },
  ]);

  const state = foldEvents(events);
  assert.equal(state.status, "completed", "期望 completed");
  assert.equal(state.steps, 2, "两条 agent.step 应折出 steps=2");
  assert.equal(state.title, "月度分析", "task.created 标题应折入");
  assert.equal(state.startedAt, 1200, "startedAt 应取 task.started 的 ts");
  assert.equal(state.endedAt, 1500, "endedAt 应取 task.completed 的 ts");
  assert.equal(state.resultJson, '{"summary":"ok"}', "完成结果应折入");
  assert.equal(state.lastEventSeq, 6, "lastEventSeq 应指向最后一条事件");
  assert.equal(state.lastEventType, "task.completed", "lastEventType 不符");

  // 输入乱序也应先按 seq 排序；且折叠不修改调用方数组。
  const shuffled = [events[5]!, events[0]!, events[3]!, events[1]!, events[4]!, events[2]!];
  assert.equal(foldEvents(shuffled).status, "completed", "乱序输入应按 seq 折叠");
  assert.deepEqual(
    events.map((event) => event.seq),
    [1, 2, 3, 4, 5, 6],
    "foldEvents 不应修改入参数组",
  );
});

test("M1-01 缺 task.started 时抛 E_INVALID_TRANSITION", () => {
  const events = makeEvents([
    { type: "task.created", actor: "user", payload: { title: "t", goal: "g" } },
    { type: "task.completed", payload: { result_json: "{}" } },
  ]);
  assert.throws(() => foldEvents(events), isInvalidTransition, "queued -> completed 必须抛错");
});

test("M1-01 completed 之后再来 task.started 抛错", () => {
  const events = makeEvents([
    { type: "task.created", actor: "user", payload: { title: "t", goal: "g" } },
    { type: "task.queued", payload: { run_id: "r_1" } },
    { type: "task.started", payload: { run_id: "r_1" } },
    { type: "task.completed", payload: { result_json: "{}" } },
    { type: "task.started", payload: { run_id: "r_2" } },
  ]);
  assert.throws(() => foldEvents(events), isInvalidTransition, "completed -> running 必须抛错");
});

test("M1-01 waiting_input 往返后折出 completed", () => {
  const events = makeEvents([
    { type: "task.created", actor: "user", payload: { title: "t", goal: "g" } },
    { type: "task.queued", payload: { run_id: "r_1" } },
    { type: "task.started", payload: { run_id: "r_1" } },
    {
      type: "agent.tool_call",
      actor: "agent",
      payload: { tool: "ask_user", args_preview: "是否继续？" },
    },
    { type: "task.started", payload: { run_id: "r_1" } },
    { type: "task.completed", payload: { result_json: "done" } },
  ]);

  const waiting = foldEvents(events.slice(0, 4));
  assert.equal(waiting.status, "waiting_input", "ask_user 后应进入 waiting_input");
  assert.equal(waiting.pendingQuestion, "是否继续？", "待回答的问题应折入");

  const state = foldEvents(events);
  assert.equal(state.status, "completed", "waiting_input -> running -> completed 应成功");
  assert.equal(state.startedAt, 1200, "恢复运行不应改写首次 startedAt");
  assert.equal(state.pendingQuestion, null, "恢复后应清空 pendingQuestion");
});

test("M1-01 failed -> queued -> started -> completed 重试路径可折", () => {
  const events = makeEvents([
    { type: "task.created", actor: "user", payload: { title: "t", goal: "g" } },
    { type: "task.queued", payload: { run_id: "r_1" } },
    { type: "task.started", payload: { run_id: "r_1" } },
    { type: "agent.step", actor: "agent", payload: { step_no: 1 } },
    { type: "task.failed", payload: { reason: "exception", attempt: 1 } },
    { type: "task.queued", payload: { run_id: "r_2" } },
    { type: "task.started", payload: { run_id: "r_2" } },
    { type: "agent.step", actor: "agent", payload: { step_no: 1 } },
    { type: "task.completed", payload: { result_json: "ok" } },
  ]);

  const failed = foldEvents(events.slice(0, 5));
  assert.equal(failed.status, "failed", "第一次执行应折出 failed");
  assert.equal(failed.error, "exception", "失败原因应折入");
  assert.equal(failed.endedAt, 1400, "failed 的 endedAt 不符");

  const state = foldEvents(events);
  assert.equal(state.status, "completed", "重试后应折出 completed");
  assert.equal(state.attempt, 2, "failed -> queued 应递增 attempt");
  assert.equal(state.steps, 2, "steps 应跨重试累计");
  assert.equal(state.startedAt, 1200, "重试应保留首次 startedAt");
  assert.equal(state.endedAt, 1800, "重试完成的 endedAt 不符");
});

test("M1-01 appendEvent seq 单调，listEvents afterSeq 分页不重不漏", () => {
  withTempDb((db) => {
    const task = insertTask(db, { title: "分页", goal: "g", workspace: "C:/ws" });
    const other = insertTask(db, { title: "另一任务", goal: "g", workspace: "C:/ws" });

    const seqs: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      seqs.push(
        appendEvent(db, {
          taskId: task.id,
          runId: i < 3 ? "r_a" : "r_b",
          type: "agent.step",
          actor: "agent",
          payload: { step_no: i + 1 },
          ts: 2000 + i,
        }),
      );
    }
    appendEvent(db, {
      taskId: other.id,
      type: "task.created",
      actor: "user",
      payload: { title: "另一任务" },
    });

    for (let i = 1; i < seqs.length; i += 1) {
      assert.ok(seqs[i]! > seqs[i - 1]!, `seq 应单调递增：${seqs.join(",")}`);
    }

    const all = listEvents(db, { taskId: task.id, limit: 100 });
    assert.deepEqual(
      all.map((event) => event.seq),
      seqs,
      "taskId 过滤结果应按 seq 升序",
    );

    const pages: TaskEvent[] = [];
    let afterSeq = 0;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = listEvents(db, { taskId: task.id, afterSeq, limit: 2 });
      if (page.length === 0) break;
      assert.ok(
        page.every((event) => event.seq > afterSeq),
        `afterSeq=${afterSeq} 的下一页应严格更大`,
      );
      pages.push(...page);
      afterSeq = page[page.length - 1]!.seq;
    }
    assert.deepEqual(
      pages.map((event) => event.seq),
      seqs,
      "afterSeq 分页应不重不漏",
    );
    assert.equal(new Set(pages.map((event) => event.seq)).size, seqs.length, "分页不应重复");

    assert.equal(listEvents(db, { taskId: task.id, runId: "r_b" }).length, 4, "runId 过滤不符");
    assert.equal(listEvents(db, { taskId: other.id }).length, 1, "taskId 过滤不符");
    assert.equal(listEvents(db, { taskId: task.id, afterSeq: seqs[6] }).length, 0, "尾页之后应为空");
    assert.equal(listEvents(db, { taskId: task.id, limit: 3 }).length, 3, "limit 不符");
  });
});

test("M1-01 repo re-export 保持 events API 兼容", () => {
  assert.equal(appendEventFromRepo, appendEvent, "repo.appendEvent 应 re-export events.appendEvent");
  assert.equal(listEventsFromRepo, listEvents, "repo.listEvents 应 re-export events.listEvents");
});

test("M1-01 foldEvents 模块零 IO", () => {
  const source = read("src/core/fold.ts");
  const specifiers = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
  assert.ok(specifiers.length > 0, "fold.ts 应只有相对导入");
  for (const spec of specifiers) {
    assert.ok(spec.startsWith("."), `fold.ts 期望相对导入，实际出现 ${spec}`);
    assert.ok(!spec.startsWith("node:"), `fold.ts 不应导入 IO 模块：${spec}`);
  }
  for (const io of ["node:fs", "node:sqlite", "node:path", "node:os"]) {
    assert.ok(!source.includes(io), `fold.ts 不应出现 ${io}`);
  }
  assert.ok(!/\brequire\s*\(/.test(source), "fold.ts 不应出现 require(");
  assert.ok(!/\bimport\s*\(/.test(source), "fold.ts 不应出现动态 import(");
});

test("M1-01 package.json 注册 verify:m1 且总 verify 包含 m1", () => {
  const pkg = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };
  assert.ok(
    pkg.scripts?.["verify:m1"]?.includes("scripts/verify/m1.test.ts"),
    "缺少 verify:m1 或未指向 m1 测试",
  );
  assert.ok(
    pkg.scripts?.verify?.includes("scripts/verify/m1.test.ts"),
    "verify 总脚本未包含 m1 测试",
  );
  assert.ok(
    pkg.scripts?.verify?.includes("scripts/verify/m0.test.ts"),
    "verify 总脚本不应丢失 m0 测试",
  );
});

test("M1-01 空流、缺 task.created 与终态后活动事件均拒绝", () => {
  assert.throws(() => foldEvents([]), isInvalidTransition, "空事件流必须抛错");

  const noCreated = makeEvents([{ type: "agent.step", actor: "agent", payload: { step_no: 1 } }]);
  assert.throws(() => foldEvents(noCreated), isInvalidTransition, "缺少 task.created 必须抛错");

  const events = makeEvents([
    { type: "task.created", actor: "user", payload: { title: "t", goal: "g" } },
    { type: "task.queued", payload: { run_id: "r_1" } },
    { type: "task.started", payload: { run_id: "r_1" } },
    { type: "agent.message", actor: "agent", payload: { text: "最后一条消息" } },
    { type: "task.cancelled", actor: "user", payload: { reason: "用户取消" } },
  ]);
  const state = foldEvents(events);
  assert.equal(state.status, "cancelled", "取消应折出 cancelled");
  assert.equal(state.lastMessage, "最后一条消息", "agent.message 应折入 lastMessage");
  assert.equal(state.endedAt, 1400, "cancelled 的 endedAt 不符");

  const afterCancel: TaskEvent = {
    seq: 6,
    taskId: "t_test",
    runId: "r_1",
    ts: 1500,
    type: "agent.step",
    actor: "agent",
    payload: { step_no: 3 },
  };
  assert.throws(
    () => foldEvents([...events, afterCancel]),
    isInvalidTransition,
    "终态之后不应再接受活动事件",
  );
});

// ── M1-02 产物写入与 FTS 索引验收 ────────────────────────────────

function makeTask(db: DatabaseSync): string {
  return insertTask(db, { title: "产物检索任务", goal: "g", workspace: "C:/ws" }).id;
}

test("M1-02 中文标题/摘要写入后按中文关键词命中并带 snippet", () => {
  withTempDb((db) => {
    const taskId = makeTask(db);
    const artifact = insertArtifact(db, {
      taskId,
      kind: "note",
      title: "月度销售分析",
      summary: "华东区环比增长 12%",
      tags: ["销售", "月报"],
      findings: ["环比由负转正"],
    });

    assert.ok(artifact.id.startsWith("a_"), `期望产物 ID 以 a_ 开头，实际 ${artifact.id}`);
    assert.equal(artifact.title, "月度销售分析", "标题读回不一致");
    assert.deepEqual(artifact.tags, ["销售", "月报"], "tags 应按 JSON 数组读回");
    assert.deepEqual(artifact.findings, ["环比由负转正"], "findings 应按 JSON 数组读回");

    // 2 字中文走短查询退化路径：trigram 的 MATCH 要求 >=3 字。
    const shortHits = searchArtifacts(db, "环比", 10);
    assert.equal(shortHits.length, 1, `期望“环比”命中 1 条，实际 ${shortHits.length}`);
    assert.equal(shortHits[0]!.id, artifact.id, "短查询命中的产物 ID 不符");
    assert.ok(shortHits[0]!.snippet.includes("环比"), `snippet 应含命中词，实际 ${shortHits[0]!.snippet}`);
    assert.ok(shortHits[0]!.snippet.includes("[环比]"), `snippet 应高亮命中词，实际 ${shortHits[0]!.snippet}`);

    // >=3 字走 FTS5 MATCH + bm25 + snippet()。
    const ftsHits = searchArtifacts(db, "环比增长", 10);
    assert.equal(ftsHits.length, 1, `期望“环比增长”命中 1 条，实际 ${ftsHits.length}`);
    assert.ok(ftsHits[0]!.snippet.includes("[环比增长]"), `snippet 应高亮 FTS 命中词，实际 ${ftsHits[0]!.snippet}`);
    assert.ok(ftsHits[0]!.score < 0, `bm25 应为负分，实际 ${ftsHits[0]!.score}`);

    // tags / findings 也进入索引。
    assert.equal(searchArtifacts(db, "月报").length, 1, "tags 中的中文应可检索");
    assert.equal(searchArtifacts(db, "由负转正").length, 1, "findings 中的中文应可检索");
  });
});

test("M1-02 不相交关键词不命中，防止假索引或全量返回", () => {
  withTempDb((db) => {
    const taskId = makeTask(db);
    insertArtifact(db, {
      taskId,
      kind: "note",
      title: "月度销售分析",
      summary: "华东区环比增长 12%",
    });

    assert.equal(searchArtifacts(db, "量子纠缠").length, 0, "4 字不相交关键词不应命中");
    assert.equal(searchArtifacts(db, "库存").length, 0, "2 字不相交关键词不应命中");
    assert.equal(searchArtifacts(db, "环比增长").length, 1, "对照关键词应命中，排除全量返回");
  });
});

test("M1-02 更新摘要后旧关键词消失、新关键词命中，并同步 title/tags/findings", () => {
  withTempDb((db) => {
    const taskId = makeTask(db);
    const artifact = insertArtifact(db, {
      taskId,
      kind: "note",
      title: "月度销售分析",
      summary: "华东区环比增长 12%",
      tags: ["渠道"],
      findings: ["环比转正"],
    });

    const updated = updateArtifactSummary(db, artifact.id, {
      summary: "华南区同比下降 3%",
      tags: ["复盘"],
      findings: ["需求下滑"],
    });
    assert.equal(updated.summary, "华南区同比下降 3%", "摘要更新未读回");
    assert.deepEqual(updated.tags, ["复盘"], "tags 更新未读回");
    assert.deepEqual(updated.findings, ["需求下滑"], "findings 更新未读回");

    assert.equal(searchArtifacts(db, "环比增长").length, 0, "旧摘要关键词不应再命中");
    assert.equal(searchArtifacts(db, "渠道").length, 0, "旧 tag 不应再命中");
    assert.equal(searchArtifacts(db, "同比下降").length, 1, "新摘要关键词应命中");
    const hits = searchArtifacts(db, "同比下降", 10);
    assert.ok(hits[0]!.snippet.includes("[同比下降]"), `新关键词 snippet 未高亮，实际 ${hits[0]!.snippet}`);

    // 字符串形式等价于只更新 summary；title 更新也要重建索引。
    const renamed = updateArtifactSummary(db, artifact.id, { title: "华南区复盘" });
    assert.equal(renamed.title, "华南区复盘", "标题更新未读回");
    assert.equal(searchArtifacts(db, "月度销售").length, 0, "旧标题关键词不应再命中");
    assert.equal(searchArtifacts(db, "华南区复盘").length, 1, "新标题关键词应命中");

    updateArtifactSummary(db, artifact.id, "西北区同比持平");
    assert.equal(getArtifact(db, artifact.id)?.summary, "西北区同比持平", "字符串 patch 未更新摘要");
    assert.equal(searchArtifacts(db, "同比下降").length, 0, "被替换的摘要关键词不应再命中");
    assert.equal(searchArtifacts(db, "同比持平").length, 1, "字符串 patch 的新关键词应命中");
  });
});

test("M1-02 多条产物按 bm25 相关性排序且 limit 生效", () => {
  withTempDb((db) => {
    const taskId = makeTask(db);
    const weak = insertArtifact(db, {
      taskId,
      kind: "note",
      title: "周报",
      summary: "环比增长 1 次",
    });
    const strong = insertArtifact(db, {
      taskId,
      kind: "note",
      title: "季度复盘",
      summary: "环比增长 环比增长 环比增长",
    });

    const all = searchArtifacts(db, "环比增长", 10);
    assert.equal(all.length, 2, `期望命中 2 条，实际 ${all.length}`);
    assert.equal(all[0]!.id, strong.id, "高频命中应排在前面");
    assert.equal(all[1]!.id, weak.id, "低频命中应排在后面");
    assert.ok(all[0]!.score <= all[1]!.score, `bm25 应升序，实际 ${all[0]!.score} / ${all[1]!.score}`);

    const limited = searchArtifacts(db, "环比增长", 1);
    assert.equal(limited.length, 1, `limit=1 期望 1 条，实际 ${limited.length}`);
    assert.equal(limited[0]!.id, strong.id, "limit 后仍应返回最相关的一条");
    const optionsLimited = searchArtifacts(db, { query: "环比增长", limit: 1 });
    assert.equal(optionsLimited.length, 1, "options 形式的 limit 也应生效");
    assert.equal(optionsLimited[0]!.id, strong.id, "options 形式的排序结果不符");
    assert.equal(searchArtifacts(db, "环比增长", 0).length, 0, "limit=0 应返回空");
    assert.equal(searchArtifacts(db, "   ", 5).length, 0, "空查询应返回空");
  });
});

test("M1-02 FTS 只索引 title/summary/tags/findings 四列", () => {
  withTempDb((db) => {
    const columns = db.prepare("PRAGMA table_info(artifact_fts)").all() as unknown as {
      name: string;
    }[];
    assert.deepEqual(
      columns.map((column) => column.name),
      ["title", "summary", "tags", "findings"],
      "FTS 列应恰好是四个检索字段",
    );

    const ddl = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'artifact_fts'")
      .get() as unknown as { sql: string };
    assert.ok(ddl.sql.includes("content='artifacts'"), "FTS 应为外部内容表");
    assert.ok(ddl.sql.includes("tokenize='trigram'"), "FTS 必须使用 trigram");
    assert.ok(!ddl.sql.includes("unicode61"), "禁止使用 unicode61");

    const taskId = makeTask(db);
    insertArtifact(db, {
      taskId,
      kind: "file",
      title: "月度销售分析",
      summary: "华东区环比增长 12%",
      path: "workspace/量子纠缠-正文.txt",
    });
    assert.equal(searchArtifacts(db, "量子纠缠").length, 0, "path/正文不应进入 FTS 索引");
    assert.equal(searchArtifacts(db, "环比增长").length, 1, "四个索引列仍应可检索");
  });
});

test("M1-02 迁移可重复执行，FTS 同步不随重复迁移失效", () => {
  withTempDb((db) => {
    assert.doesNotThrow(() => migrate(db), "新库再次迁移不应报错");
    assert.doesNotThrow(() => migrate(db), "连续第三次迁移不应报错");
    const versions = db
      .prepare("SELECT COUNT(*) AS n FROM schema_migrations")
      .get() as unknown as { n: number };
    assert.equal(versions.n, 1, `迁移版本记录应只有 1 条，实际 ${versions.n}`);

    const taskId = makeTask(db);
    insertArtifact(db, {
      taskId,
      kind: "dataset",
      title: "月度销售分析",
      summary: "华东区环比增长 12%",
    });
    assert.equal(searchArtifacts(db, "环比增长").length, 1, "重复迁移后 FTS 仍应可用");
  });
});

test("M1-02 给不存在的任务插产物抛 E_NOT_FOUND 且不写索引", () => {
  withTempDb((db) => {
    assert.throws(
      () =>
        insertArtifact(db, {
          taskId: "t_missing",
          kind: "note",
          title: "孤儿产物",
          summary: "不应写入",
        }),
      (err: unknown) => {
        assert.ok(err instanceof ContractError, `期望 ContractError，实际 ${String(err)}`);
        assert.equal(err.code, ERROR_CODES.E_NOT_FOUND, "错误码应为 E_NOT_FOUND");
        return true;
      },
      "不存在的 task_id 必须被拒绝",
    );
    assert.equal(searchArtifacts(db, "孤儿产物").length, 0, "被拒绝的插入不应留下索引");
  });
});
