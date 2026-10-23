import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
