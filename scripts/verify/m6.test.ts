import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(read(path));
  assert.ok(isRecord(parsed), `预期 ${path} 是 JSON 对象，实际 ${typeof parsed}`);
  return parsed;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  assert.ok(isRecord(value), `预期 ${label} 是对象，实际 ${String(value)}`);
  return value;
}

function requireString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  assert.equal(typeof value, "string", `预期 ${label}.${key} 是字符串，实际 ${String(value)}`);
  return value as string;
}

// ── 1. web tsconfig ──────────────────────────────────────────────

test("M6-01 web tsconfig：jsx=react-jsx、DOM lib、strict、noEmit", () => {
  const config = readJson("src/web/tsconfig.json");
  const options = asRecord(config.compilerOptions, "src/web/tsconfig.json compilerOptions");

  assert.equal(options.jsx, "react-jsx", `预期 jsx=react-jsx，实际 ${String(options.jsx)}`);
  assert.equal(options.noEmit, true, `预期 noEmit=true，实际 ${String(options.noEmit)}`);
  assert.equal(options.strict, true, `预期 strict=true，实际 ${String(options.strict)}`);
  assert.equal(
    options.moduleResolution,
    "Bundler",
    `预期 moduleResolution=Bundler，实际 ${String(options.moduleResolution)}`,
  );

  const lib = options.lib;
  assert.ok(Array.isArray(lib), `预期 lib 是数组，实际 ${String(lib)}`);
  assert.ok(lib.includes("DOM"), `预期 lib 包含 DOM，实际 ${JSON.stringify(lib)}`);
  assert.ok(
    lib.includes("DOM.Iterable"),
    `预期 lib 包含 DOM.Iterable，实际 ${JSON.stringify(lib)}`,
  );
});

// ── 2. 根 tsconfig 必须排除 web ──────────────────────────────────

test("M6-01 根 tsconfig：exclude 包含 src/web/node_modules/dist", () => {
  const config = readJson("tsconfig.json");
  const exclude = config.exclude;
  assert.ok(Array.isArray(exclude), `预期 exclude 是数组，实际 ${String(exclude)}`);
  for (const entry of ["src/web", "node_modules", "dist"]) {
    assert.ok(
      exclude.includes(entry),
      `预期 exclude 包含 ${entry}，实际 ${JSON.stringify(exclude)}`,
    );
  }
});

// ── 3. 依赖白名单 ───────────────────────────────────────────────

test("M6-01 依赖：dependencies/devDependencies 逐项限定在白名单内", () => {
  const pkg = readJson("package.json");

  const allowedDependencies = new Set([
    "fastify",
    "react",
    "react-dom",
    "antd",
    "@tanstack/react-query",
    "@tanstack/react-virtual",
    "react-markdown",
  ]);
  const allowedDevDependencies = new Set([
    "@types/node",
    "prettier",
    "typescript",
    "vite",
    "@vitejs/plugin-react",
    "@types/react",
    "@types/react-dom",
  ]);

  const dependencies = asRecord(pkg.dependencies, "package.json dependencies");
  const devDependencies = asRecord(pkg.devDependencies, "package.json devDependencies");

  for (const name of Object.keys(dependencies)) {
    assert.ok(allowedDependencies.has(name), `预期 dependencies 只含白名单依赖，实际出现 ${name}`);
  }
  for (const name of Object.keys(devDependencies)) {
    assert.ok(
      allowedDevDependencies.has(name),
      `预期 devDependencies 只含白名单依赖，实际出现 ${name}`,
    );
  }

  for (const name of ["react", "react-dom", "antd", "@tanstack/react-query"]) {
    assert.ok(
      name in dependencies,
      `预期 dependencies 包含 ${name}，实际 ${JSON.stringify(Object.keys(dependencies))}`,
    );
  }
  for (const name of ["vite", "@vitejs/plugin-react", "@types/react", "@types/react-dom"]) {
    assert.ok(
      name in devDependencies,
      `预期 devDependencies 包含 ${name}，实际 ${JSON.stringify(Object.keys(devDependencies))}`,
    );
  }
});

// ── 4. 文件与关键配置 ───────────────────────────────────────────

test("M6-01 文件：index.html/看板/API/详情页存在，代理与状态配置就位", () => {
  for (const path of [
    "src/web/index.html",
    "src/web/vite.config.ts",
    "src/web/src/main.tsx",
    "src/web/src/App.tsx",
    "src/web/src/api.ts",
    "src/web/src/pages/TaskBoard.tsx",
    "src/web/src/pages/TaskDetail.tsx",
    "scripts/dev.ts",
  ]) {
    assert.ok(existsSync(join(root, path)), `预期文件存在：${path}`);
  }

  const html = read("src/web/index.html");
  assert.ok(html.includes("任务终端"), `预期 index.html 标题含「任务终端」，实际 ${html}`);

  const board = read("src/web/src/pages/TaskBoard.tsx");
  assert.match(board, /refetchInterval:\s*2000/, "预期看板以 refetchInterval: 2000 轮询");
  assert.ok(board.includes("Empty"), "预期看板包含 Empty 空态");
  assert.ok(board.includes("新建任务"), "预期看板包含「新建任务」按钮");
  for (const status of ["queued", "running", "completed", "failed", "waiting_input", "cancelled"]) {
    assert.ok(board.includes(`${status}:`), `预期看板状态映射包含 ${status}`);
  }

  const viteConfig = read("src/web/vite.config.ts");
  assert.match(viteConfig, /outDir:\s*"\.\.\/\.\.\/dist"/, "预期 build.outDir 为 ../../dist");
  assert.match(viteConfig, /port:\s*5173/, "预期 dev server 端口为 5173");
  assert.ok(viteConfig.includes("http://127.0.0.1:4310"), "预期代理目标为 http://127.0.0.1:4310");
  for (const route of ["tasks", "events", "artifacts", "messages", "chat"]) {
    assert.ok(viteConfig.includes(`"/${route}"`), `预期代理包含 /${route}`);
  }
});

// ── 5. 脚本注册 ─────────────────────────────────────────────────

test("M6-01 scripts：dev/dev:web/build/typecheck/verify:m6 注册正确", () => {
  const pkg = readJson("package.json");
  const scripts = asRecord(pkg.scripts, "package.json scripts");

  assert.equal(requireString(scripts, "dev", "scripts"), "node scripts/dev.ts");
  assert.equal(
    requireString(scripts, "dev:web", "scripts"),
    "vite --config src/web/vite.config.ts --configLoader native",
    "预期 dev:web 使用 Vite 与 web 配置",
  );
  assert.equal(
    requireString(scripts, "build", "scripts"),
    "vite build --config src/web/vite.config.ts --configLoader native",
    "预期 build 使用 vite build 与 web 配置",
  );
  assert.equal(
    requireString(scripts, "typecheck", "scripts"),
    "tsc -p tsconfig.json && tsc -p src/web/tsconfig.json",
    "预期 typecheck 同时检查根与 web 两份 tsconfig",
  );
  assert.equal(
    requireString(scripts, "verify:m6", "scripts"),
    "node --test --test-isolation=none scripts/verify/m6.test.ts",
  );

  const verify = requireString(scripts, "verify", "scripts");
  assert.ok(
    verify.includes("scripts/verify/m6.test.ts"),
    `预期总 verify 追加 m6.test.ts，实际 ${verify}`,
  );
});

// ── 6. 构建 ─────────────────────────────────────────────────────

test("M6-01/M6-02 构建：pnpm build 退出码 0 且 dist/index.html 存在", { timeout: 240_000 }, () => {
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

// ── 7. M6-02 新增依赖 ───────────────────────────────────────────

test("M6-02 依赖：仅新增 @tanstack/react-virtual 与 react-markdown，lockfile 已同步", () => {
  const pkg = readJson("package.json");
  const dependencies = asRecord(pkg.dependencies, "package.json dependencies");

  for (const name of ["@tanstack/react-virtual", "react-markdown"]) {
    assert.ok(
      name in dependencies,
      `预期 dependencies 包含 ${name}，实际 ${JSON.stringify(Object.keys(dependencies))}`,
    );
    const version = requireString(dependencies, name, "package.json dependencies");
    assert.ok(version.length > 0, `预期 ${name} 有版本号，实际空字符串`);
  }

  const lock = read("pnpm-lock.yaml");
  assert.ok(lock.includes("react-markdown@"), "预期 pnpm-lock.yaml 含 react-markdown 解析记录");
  assert.ok(
    lock.includes("@tanstack/react-virtual@"),
    "预期 pnpm-lock.yaml 含 @tanstack/react-virtual 解析记录",
  );
});

// ── 8. M6-02 文件与虚拟列表 ─────────────────────────────────────

test("M6-02 文件：useTaskEvents / EventTimeline / TaskHeader 拆包存在", () => {
  for (const path of [
    "src/web/src/hooks/useTaskEvents.ts",
    "src/web/src/components/EventTimeline.tsx",
    "src/web/src/components/TaskHeader.tsx",
    "src/web/src/taskActions.ts",
  ]) {
    assert.ok(existsSync(join(root, path)), `预期文件存在：${path}`);
  }

  const timeline = read("src/web/src/components/EventTimeline.tsx");
  assert.ok(
    timeline.includes("useVirtualizer"),
    "预期 EventTimeline 使用 @tanstack/react-virtual 的 useVirtualizer",
  );
  assert.ok(
    timeline.includes("measureElement"),
    "预期 EventTimeline 用 measureElement 支持动态行高",
  );
  assert.ok(
    timeline.includes("getVirtualItems"),
    "预期 EventTimeline 只渲染 virtualItems（真实虚拟化）",
  );
  for (const marker of ["agent.message", "agent.tool_call", "agent.tool_result", "llm.call"]) {
    assert.ok(timeline.includes(marker), `预期 EventTimeline 渲染 ${marker}`);
  }
  assert.ok(timeline.includes("ReactMarkdown"), "预期 agent.message 用 react-markdown 渲染");
  assert.ok(timeline.includes("<details"), "预期 payload JSON 用 details 折叠");
  assert.ok(timeline.includes("缓存命中"), "预期 llm.call 对缓存命中做绿色标注");

  const detail = read("src/web/src/pages/TaskDetail.tsx");
  assert.ok(detail.includes("useTaskEvents"), "预期 TaskDetail 接入 useTaskEvents");
  assert.ok(detail.includes("EventTimeline"), "预期 TaskDetail 渲染 EventTimeline");
  assert.ok(detail.includes("TaskHeader"), "预期 TaskDetail 渲染 TaskHeader");
  assert.ok(detail.includes("cancelTask"), "预期 TaskDetail 接入取消动作");
  assert.ok(detail.includes("retryTask"), "预期 TaskDetail 接入重试动作");
  assert.ok(!detail.includes("JSON.stringify"), "预期详情页不再直出 JSON 占位");
});

// ── 9. M6-02 SSE 缓冲与断线重连 ─────────────────────────────────

test("M6-02 useTaskEvents：SSE onmessage 只入缓冲，24ms flush 一次 setState（上限 1000）", () => {
  const source = read("src/web/src/hooks/useTaskEvents.ts");

  assert.ok(source.includes("new EventSource("), "预期使用 EventSource 接收增量事件");
  assert.ok(source.includes("addEventListener"), "预期注册 SPEC 事件名的命名事件监听");
  assert.ok(source.includes("SSE_EVENT_TYPES"), "预期维护事件类型白名单");
  assert.match(source, /FLUSH_INTERVAL_MS\s*=\s*24/, "预期合批窗口为 24ms（16–32ms 之间）");
  assert.match(source, /MAX_BUFFERED_EVENTS\s*=\s*1000/, "预期缓冲上限 1000 条后强制 flush");
  assert.ok(
    source.includes("FLUSH_INTERVAL_MS") && source.includes("setTimeout"),
    "预期用 setTimeout 触发 flush，而不是每条事件立即渲染",
  );

  const onMessageStart = source.indexOf("source.onmessage");
  assert.ok(onMessageStart >= 0, "预期存在 source.onmessage 处理器");
  const onMessageEnd = source.indexOf("};", onMessageStart);
  assert.ok(onMessageEnd > onMessageStart, "预期能定位 onmessage 代码块");
  const onMessageBlock = source.slice(onMessageStart, onMessageEnd + 2);
  assert.ok(
    onMessageBlock.includes("enqueueEvent"),
    `预期 onmessage 把事件放入缓冲（enqueueEvent），实际：${onMessageBlock}`,
  );
  assert.ok(
    !onMessageBlock.includes("setEvents"),
    `预期 onmessage 不直接 setEvents，实际：${onMessageBlock}`,
  );

  const flushStart = source.indexOf("const flushBuffer");
  assert.ok(flushStart >= 0, "预期存在 flushBuffer");
  const flushEnd = source.indexOf("}, []);", flushStart);
  assert.ok(flushEnd > flushStart, "预期能定位 flushBuffer 代码块");
  const flushBlock = source.slice(flushStart, flushEnd);
  const setEventsCalls = flushBlock.match(/setEvents\(/g) ?? [];
  assert.equal(
    setEventsCalls.length,
    1,
    `预期每次 flush 只调用一次 setEvents，实际 ${setEventsCalls.length} 次`,
  );

  assert.match(source, /\/events\?after=\$\{/, "预期 EventSource URL 携带 after 游标");
  assert.ok(source.includes("taskId=${encodeURIComponent(taskId)}"), "预期 SSE URL 带 taskId 过滤");
  assert.ok(source.includes("cursorRef"), "预期用游标记录最大 seq");
  assert.ok(source.includes("getTaskDetail(taskId)"), "预期断线重连前先 GET 补漏");
  assert.ok(
    source.includes("source.close()") || source.includes("liveSource?.close()"),
    "预期卸载/重连时关闭 EventSource",
  );
  assert.ok(source.includes("scheduleReconnect"), "预期 onerror 触发自定义重连流程");
});
