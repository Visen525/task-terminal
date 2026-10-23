import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
