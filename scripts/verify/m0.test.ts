import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  EVENT_TYPES,
  RUN_STATUSES,
  TASK_STATUSES,
  type EventType,
  type RunStatus,
  type TaskStatus,
} from "../../src/core/types.ts";
import {
  RUN_TRANSITIONS,
  TASK_TRANSITIONS,
  assertRunTransition,
  assertTransition,
  canRunTransition,
  canTransition,
  isTerminalRunStatus,
  isTerminalTaskStatus,
} from "../../src/core/state.ts";
import { ContractError, ERROR_CODES } from "../../src/core/errors.ts";
import { migrate, openDatabase } from "../../src/store/migrate.ts";
import {
  appendEvent,
  finishRun,
  getRun,
  getTask,
  insertRun,
  insertTask,
  listEvents,
  listTasks,
  renewRunLease,
  updateTaskStatus,
} from "../../src/store/repo.ts";
import { isUlid, newTaskId, newUlid } from "../../src/store/ulid.ts";

const root = join(import.meta.dirname, "..", "..");
const read = (p: string): string => readFileSync(join(root, p), "utf8");
const has = (p: string): boolean => existsSync(join(root, p));

test("Node 版本 >= 24", () => {
  const major = Number(process.versions.node.split(".")[0]);
  assert.ok(major >= 24, `需要 Node 24+，当前 ${process.versions.node}`);
});

test("package.json 是 ESM 且脚本齐全", () => {
  const pkg = JSON.parse(read("package.json")) as {
    type?: string;
    private?: boolean;
    scripts?: Record<string, string>;
  };
  assert.equal(pkg.type, "module");
  assert.equal(pkg.private, true);
  assert.ok(pkg.scripts?.verify, "缺少 verify 脚本");
  assert.ok(pkg.scripts?.["verify:m0"], "缺少 verify:m0 脚本");
});

test("tsconfig 启用 strict 且允许直接运行 .ts", () => {
  const ts = JSON.parse(read("tsconfig.json")) as {
    compilerOptions?: Record<string, unknown>;
  };
  const o = ts.compilerOptions ?? {};
  assert.equal(o.strict, true);
  assert.equal(o.noEmit, true);
  assert.equal(o.allowImportingTsExtensions, true);
  assert.equal(o.erasableSyntaxOnly, true);
});

test(".gitignore 覆盖数据、密钥与依赖", () => {
  const gi = read(".gitignore");
  for (const rule of ["node_modules/", "data/", "workspace/", ".env", "*.db"]) {
    assert.ok(gi.includes(rule), `缺少忽略规则：${rule}`);
  }
});

test(".env.example 只含键名", () => {
  const env = read(".env.example");
  assert.ok(env.includes("DEEPSEEK_API_KEY="), "缺少 DEEPSEEK_API_KEY 占位");
  assert.ok(!/DEEPSEEK_API_KEY=.+/.test(env), ".env.example 不许出现真实值");
});

test("config.example.yaml 含关键段落", () => {
  const cfg = read("config.example.yaml");
  for (const key of ["model:", "provider: deepseek", "workspace:", "limits:", "data:"]) {
    assert.ok(cfg.includes(key), `配置缺少：${key}`);
  }
});

test("SPEC 与示例工作区就位", () => {
  assert.ok(has("docs/SPEC.md"), "缺少 docs/SPEC.md");
  assert.ok(read("docs/SPEC.md").length > 10000, "SPEC.md 内容异常（应 >10000 字符）");
  assert.ok(has("examples/workspace-sample/README.md"), "缺少示例工作区");
});

// ── M0-02 契约层验收 ─────────────────────────────────────────────

test("M0-02 合法任务转移与 SPEC §4.3 一致", () => {
  const legal: [TaskStatus, TaskStatus][] = [
    ["queued", "running"],
    ["running", "completed"],
    ["running", "failed"],
    ["running", "waiting_input"],
    ["running", "cancelled"],
    ["waiting_input", "running"],
    ["failed", "queued"],
  ];
  for (const [from, to] of legal) {
    assert.equal(canTransition(from, to), true, `期望 ${from}->${to} 合法，实际 false`);
  }
  assert.equal(
    TASK_TRANSITIONS.length,
    legal.length,
    `期望任务转移 ${legal.length} 条，实际 ${TASK_TRANSITIONS.length}`,
  );
});

test("M0-02 非法任务转移一律返回 false", () => {
  const illegal: [TaskStatus, TaskStatus][] = [
    ["completed", "running"],
    ["cancelled", "queued"],
    ["queued", "completed"],
    ["waiting_input", "completed"],
    ["failed", "completed"],
    ["queued", "queued"],
    ["running", "queued"],
  ];
  for (const [from, to] of illegal) {
    assert.equal(canTransition(from, to), false, `期望 ${from}->${to} 非法，实际 true`);
  }
  // 未知状态：运行期收到脏数据也必须返回 false 而不是崩溃
  assert.equal(canTransition("bogus" as TaskStatus, "running"), false, "期望未知状态返回 false，实际 true");
});

test("M0-02 非终态至少一条合法出边，终态无出边", () => {
  for (const status of TASK_STATUSES) {
    const out = TASK_TRANSITIONS.filter((t) => t.from === status).length;
    if (isTerminalTaskStatus(status)) {
      assert.equal(out, 0, `终态 ${status} 期望 0 条出边，实际 ${out}`);
    } else {
      assert.ok(out >= 1, `非终态 ${status} 期望至少 1 条出边，实际 ${out}`);
    }
  }
  for (const status of RUN_STATUSES) {
    const out = RUN_TRANSITIONS.filter((t) => t.from === status).length;
    if (isTerminalRunStatus(status)) {
      assert.equal(out, 0, `Run 终态 ${status} 期望 0 条出边，实际 ${out}`);
    } else {
      assert.ok(out >= 1, `Run 非终态 ${status} 期望至少 1 条出边，实际 ${out}`);
    }
  }
});

test("M0-02 Run 转移表只从 running 出发", () => {
  const legal: [RunStatus, RunStatus][] = [
    ["running", "completed"],
    ["running", "failed"],
    ["running", "interrupted"],
    ["running", "cancelled"],
  ];
  for (const [from, to] of legal) {
    assert.equal(canRunTransition(from, to), true, `期望 run ${from}->${to} 合法，实际 false`);
  }
  assert.equal(
    RUN_TRANSITIONS.length,
    legal.length,
    `期望 run 转移 ${legal.length} 条，实际 ${RUN_TRANSITIONS.length}`,
  );
  assert.equal(canRunTransition("completed", "running"), false, "期望 run completed->running 非法，实际 true");
});

test("M0-02 状态集与 SPEC 完全一致且无重复", () => {
  assert.deepEqual(
    [...TASK_STATUSES],
    ["queued", "running", "completed", "failed", "waiting_input", "cancelled"],
    "任务状态集与 SPEC §4.3 不一致",
  );
  assert.equal(new Set(TASK_STATUSES).size, TASK_STATUSES.length, "任务状态存在重复");
  assert.deepEqual(
    [...RUN_STATUSES],
    ["running", "completed", "failed", "interrupted", "cancelled"],
    "Run 状态集与 SPEC §4.2 不一致",
  );
  assert.equal(new Set(RUN_STATUSES).size, RUN_STATUSES.length, "Run 状态存在重复");
});

test("M0-02 事件类型与 SPEC §4.4 一致且无重复", () => {
  const expected: EventType[] = [
    "task.created",
    "task.queued",
    "task.started",
    "agent.step",
    "llm.call",
    "agent.message",
    "agent.tool_call",
    "agent.tool_result",
    "artifact.created",
    "summary.generated",
    "budget.warning",
    "task.completed",
    "task.failed",
    "task.cancelled",
    "memory.fact_upserted",
  ];
  assert.deepEqual([...EVENT_TYPES], expected, "事件类型集与 SPEC §4.4 不一致");
  assert.equal(new Set(EVENT_TYPES).size, EVENT_TYPES.length, "事件类型存在重复");
});

test("M0-02 错误码无重复，assertTransition 抛 ContractError", () => {
  const codes = Object.values(ERROR_CODES);
  assert.equal(new Set(codes).size, codes.length, "错误码存在重复");
  for (const [key, value] of Object.entries(ERROR_CODES)) {
    assert.equal(value, key, `期望错误码 ${key} 的值等于键名，实际 ${value}`);
  }
  assert.doesNotThrow(() => assertTransition("queued", "running"), "合法转移不应抛错");
  assert.throws(
    () => assertTransition("queued", "completed"),
    (err: unknown) => {
      assert.ok(err instanceof ContractError, `期望 ContractError，实际 ${String(err)}`);
      assert.equal(err.code, ERROR_CODES.E_INVALID_TRANSITION, "错误码不符");
      assert.equal(err.name, "ContractError", "错误名不符");
      return true;
    },
    "非法转移必须抛 ContractError",
  );
  assert.throws(() => assertRunTransition("completed", "running"), ContractError, "非法 run 转移必须抛 ContractError");
});

test("M0-02 契约层零依赖零 IO", () => {
  for (const file of ["src/core/types.ts", "src/core/state.ts", "src/core/errors.ts"]) {
    const source = read(file);
    const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] as string);
    for (const spec of specifiers) {
      assert.ok(spec.startsWith("."), `${file} 期望只引用相对路径，实际出现 ${spec}`);
    }
    assert.ok(!source.includes("require("), `${file} 不应出现 require(`);
  }
});

// ── M0-03 数据库迁移与仓储验收 ───────────────────────────────────

function withTempDb<T>(fn: (db: DatabaseSync, file: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "task-terminal-test-"));
  const file = join(dir, "test.db");
  const db = openDatabase(file);
  try {
    return fn(db, file);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("M0-03 迁移幂等、WAL 生效、八张表 + FTS 就位", () => {
  const dir = mkdtempSync(join(tmpdir(), "task-terminal-mig-"));
  const file = join(dir, "test.db");
  const db = openDatabase(file);
  const mode = db.prepare("PRAGMA journal_mode").get() as unknown as { journal_mode: string };
  assert.equal(mode.journal_mode, "wal", `期望 journal_mode=wal，实际 ${mode.journal_mode}`);

  const names = new Set(
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
        .all() as unknown as { name: string }[]
    ).map((row) => row.name),
  );
  for (const table of [
    "tasks",
    "runs",
    "events",
    "messages",
    "artifacts",
    "artifact_fts",
    "memory_facts",
    "llm_calls",
    "schema_migrations",
  ]) {
    assert.ok(names.has(table), `期望表 ${table} 存在，实际不存在`);
  }

  migrate(db); // 重复迁移不报错
  db.close();
  const reopened = openDatabase(file); // 重开也不报错
  const count = reopened
    .prepare("SELECT COUNT(*) AS n FROM schema_migrations")
    .get() as unknown as { n: number };
  assert.equal(count.n, 1, `期望迁移版本记录 1 条，实际 ${count.n}`);
  reopened.close();
  rmSync(dir, { recursive: true, force: true });
});

test("M0-03 任务插入读回 + 状态机 + revision CAS", () => {
  withTempDb((db) => {
    const task = insertTask(db, {
      title: "月度分析",
      goal: "把 workspace/report 的 CSV 整理成月度分析",
      workspace: "C:/ws",
    });
    assert.ok(task.id.startsWith("t_"), `期望任务 ID 以 t_ 开头，实际 ${task.id}`);
    assert.ok(isUlid(task.id.slice(2)), `期望任务 ID 主体是 ULID，实际 ${task.id}`);
    assert.equal(task.status, "queued", "新任务状态应为 queued");
    assert.equal(task.revision, 1, "新任务 revision 应为 1");

    const got = getTask(db, task.id);
    assert.equal(got?.title, "月度分析", "任务标题读回不一致");
    assert.equal(getTask(db, "t_missing"), null, "不存在的任务应返回 null");

    assert.throws(
      () => updateTaskStatus(db, task.id, "completed"),
      (err: unknown) => err instanceof ContractError && err.code === ERROR_CODES.E_INVALID_TRANSITION,
      "queued -> completed 必须被拒绝",
    );
    assert.throws(
      () => updateTaskStatus(db, "t_missing", "running"),
      (err: unknown) => err instanceof ContractError && err.code === ERROR_CODES.E_NOT_FOUND,
      "更新不存在的任务必须抛 E_NOT_FOUND",
    );

    const running = updateTaskStatus(db, task.id, "running", { expectedRevision: 1, now: 1000 });
    assert.equal(running.status, "running", "期望 running，实际 " + running.status);
    assert.equal(running.revision, 2, `期望 revision=2，实际 ${running.revision}`);
    assert.equal(running.startedAt, 1000, `期望 startedAt=1000，实际 ${running.startedAt}`);

    assert.throws(
      () => updateTaskStatus(db, task.id, "completed", { expectedRevision: 1 }),
      (err: unknown) => err instanceof ContractError && err.code === ERROR_CODES.E_CONFLICT,
      "陈旧 revision 必须抛 E_CONFLICT",
    );

    const done = updateTaskStatus(db, task.id, "completed", {
      expectedRevision: 2,
      resultJson: '{"summary":"ok"}',
      now: 2000,
    });
    assert.equal(done.status, "completed", "期望 completed");
    assert.equal(done.endedAt, 2000, `期望 endedAt=2000，实际 ${done.endedAt}`);
    assert.equal(listTasks(db, { status: "completed" }).length, 1, "按状态筛选应命中 1 条");
    assert.equal(listTasks(db, { status: "queued" }).length, 0, "queued 应为 0 条");
  });
});

test("M0-03 Run 生命周期与租约", () => {
  withTempDb((db) => {
    const task = insertTask(db, { title: "t", goal: "g", workspace: "C:/ws" });
    assert.throws(
      () => insertRun(db, { taskId: "t_missing", attempt: 1 }),
      (err: unknown) => err instanceof ContractError && err.code === ERROR_CODES.E_NOT_FOUND,
      "给不存在的任务建 run 必须抛 E_NOT_FOUND",
    );

    const run = insertRun(db, { taskId: task.id, attempt: 1, now: 1000 });
    assert.ok(run.id.startsWith("r_"), `期望 run ID 以 r_ 开头，实际 ${run.id}`);
    assert.equal(run.leaseUntil, 61_000, `期望默认租约 61s，实际 ${run.leaseUntil}`);

    const renewed = renewRunLease(db, run.id, 41_000, 3);
    assert.equal(renewed.leaseUntil, 41_000, "续约后 leaseUntil 不符");
    assert.equal(renewed.steps, 3, `期望 steps=3，实际 ${renewed.steps}`);

    const done = finishRun(db, run.id, "completed", { now: 5000 });
    assert.equal(done.status, "completed", "期望 run completed");
    assert.equal(done.endedAt, 5000, `期望 endedAt=5000，实际 ${done.endedAt}`);
    assert.throws(
      () => finishRun(db, run.id, "cancelled"),
      (err: unknown) => err instanceof ContractError && err.code === ERROR_CODES.E_INVALID_TRANSITION,
      "已结束的 run 不能再次收尾",
    );
    assert.throws(
      () => renewRunLease(db, run.id, 61_000),
      (err: unknown) => err instanceof ContractError && err.code === ERROR_CODES.E_INVALID_TRANSITION,
      "已结束的 run 不能续约",
    );
    assert.equal(getRun(db, "r_missing"), null, "不存在的 run 应返回 null");
  });
});

test("M0-03 事件 seq 单调、afterSeq 续读、append-only 不可改删", () => {
  withTempDb((db) => {
    const task = insertTask(db, { title: "t", goal: "g", workspace: "C:/ws" });
    const seq1 = appendEvent(db, {
      taskId: task.id,
      type: "task.created",
      actor: "user",
      payload: { title: "t" },
    });
    const seq2 = appendEvent(db, {
      taskId: task.id,
      type: "task.queued",
      actor: "system",
      payload: { run_id: "r_1" },
    });
    const seq3 = appendEvent(db, {
      taskId: task.id,
      type: "task.started",
      actor: "system",
      payload: { run_id: "r_1" },
    });
    assert.ok(seq1 < seq2 && seq2 < seq3, `期望 seq 单调递增，实际 ${seq1},${seq2},${seq3}`);

    const after = listEvents(db, { taskId: task.id, afterSeq: seq1 });
    assert.equal(after.length, 2, `期望续读 2 条，实际 ${after.length}`);
    assert.deepEqual(after[0]?.payload, { run_id: "r_1" }, "事件 payload 反序列化不一致");

    assert.throws(
      () => {
        db.prepare("UPDATE events SET payload = ? WHERE seq = ?").run("{}", seq1);
      },
      /append-only/,
      "events UPDATE 必须被触发器拒绝",
    );
    assert.throws(
      () => {
        db.prepare("DELETE FROM events WHERE seq = ?").run(seq1);
      },
      /append-only/,
      "events DELETE 必须被触发器拒绝",
    );
    assert.equal(listEvents(db, { taskId: task.id }).length, 3, "被拒绝的改删不应影响事件数");
  });
});

test("M0-03 ULID 格式与唯一性", () => {
  const ids = new Set<string>();
  for (let i = 0; i < 500; i += 1) {
    const id = newUlid();
    assert.equal(id.length, 26, `期望 ULID 长度 26，实际 ${id.length}`);
    assert.ok(isUlid(id), `期望合法 ULID，实际 ${id}`);
    ids.add(id);
  }
  assert.equal(ids.size, 500, `期望 500 个唯一 ULID，实际 ${ids.size}`);
  const taskId = newTaskId();
  assert.ok(taskId.startsWith("t_") && isUlid(taskId.slice(2)), `期望 t_+ULID，实际 ${taskId}`);
});

test("M0-03 中文 FTS（trigram）可命中", () => {
  withTempDb((db) => {
    const task = insertTask(db, { title: "销售分析", goal: "分析销售", workspace: "C:/ws" });
    db.prepare(
      `INSERT INTO artifacts (id, task_id, kind, title, summary, tags, findings, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "a_1",
      task.id,
      "note",
      "销售月报",
      "本月环比增长百分之十二",
      '["销售"]',
      "[]",
      Date.now(),
    );
    db.exec("INSERT INTO artifact_fts(artifact_fts) VALUES('rebuild');");
    const hits = db
      .prepare("SELECT title FROM artifact_fts WHERE artifact_fts MATCH ?")
      .all("环比增长") as unknown as { title: string }[];
    assert.equal(hits.length, 1, `期望中文检索命中 1 条，实际 ${hits.length}`);
    assert.equal(hits[0]?.title, "销售月报", "命中记录 title 不一致");
  });
});
