import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { FakeProvider } from "../../src/providers/fake.ts";
import type { Scheduler } from "../../src/runtime/scheduler.ts";
import { createApp } from "../../src/server/index.ts";
import { insertArtifact } from "../../src/store/artifacts.ts";
import { openDatabase } from "../../src/store/migrate.ts";
import { insertTask } from "../../src/store/repo.ts";

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
    "@ant-design/icons",
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

// ════════════════════════════════════════════════════════════════
// M6-03 产物库与对话
// ════════════════════════════════════════════════════════════════

function stubScheduler(): { scheduler: Scheduler; ticks: string[] } {
  const ticks: string[] = [];
  const scheduler: Scheduler = {
    tick: async () => {
      ticks.push(String(Date.now()));
      return { started: false, reason: "empty" };
    },
    runAll: async () => [],
    shutdown: async () => undefined,
    cancel: () => false,
  };
  return { scheduler, ticks };
}

interface ChatSseFrame {
  event: string | null;
  data: string | null;
}

function parseChatSse(body: string): ChatSseFrame[] {
  return body
    .split("\n\n")
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      let event: string | null = null;
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /u, ""));
      }
      return { event, data: data.length > 0 ? data.join("\n") : null };
    });
}

function payloadOf(frame: ChatSseFrame | undefined, label: string): Record<string, unknown> {
  assert.ok(frame !== undefined, `预期存在 ${label} 帧`);
  assert.ok(frame.data !== null, `预期 ${label} 帧带 data`);
  const parsed: unknown = JSON.parse(frame.data);
  return asRecord(parsed, `${label} data`);
}

async function withServerDb(
  fn: (context: { base: string; db: DatabaseSync }) => Promise<void>,
): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), "task-terminal-m6-"));
  const workspace = join(base, "ws");
  mkdirSync(workspace);
  const db = openDatabase(":memory:");
  try {
    await fn({ base: workspace, db });
  } finally {
    db.close();
    rmSync(base, { recursive: true, force: true });
  }
}

// ── 10. 文件与源码接线 ─────────────────────────────────────────

test("M6-03 文件：Chat/Artifacts 页面与前端 API 存在，App 菜单已接通", () => {
  for (const path of [
    "src/web/src/pages/Chat.tsx",
    "src/web/src/pages/Artifacts.tsx",
    "src/web/src/chatApi.ts",
    "src/web/src/artifactApi.ts",
  ]) {
    assert.ok(existsSync(join(root, path)), `预期文件存在：${path}`);
  }

  const app = read("src/web/src/App.tsx");
  assert.ok(app.includes('import Chat from "./pages/Chat"'), "预期 App 导入 Chat 页面");
  assert.ok(app.includes('import Artifacts from "./pages/Artifacts"'), "预期 App 导入 Artifacts 页面");
  assert.ok(app.includes("<Chat />"), "预期 App 渲染 Chat 页面");
  assert.ok(app.includes("<Artifacts"), "预期 App 渲染 Artifacts 页面");
  assert.ok(!app.includes("产物列表与详情将在 M6-03 交付"), "预期产物库占位已移除");
  assert.ok(!app.includes("主 AI 对话界面将在 M6-03 交付"), "预期对话占位已移除");
});

test("M6-03 server 源码：POST /chat、GET /messages、GET /artifacts/:id 与 delta/done/error 事件", () => {
  const server = read("src/server/index.ts");
  assert.ok(server.includes("app.post('/chat'"), "预期 POST /chat 路由");
  assert.ok(server.includes("app.get('/messages'"), "预期 GET /messages 路由");
  assert.ok(server.includes("app.get('/artifacts/:id'"), "预期 GET /artifacts/:id 路由");
  for (const event of ["event: delta", "event: done", "event: error"]) {
    assert.ok(server.includes(event), `预期 server 源码包含 ${event}`);
  }
  assert.ok(server.includes("runMainTurn("), "预期 POST /chat 调用 runMainTurn");
  assert.ok(server.includes("onTextDelta"), "预期 POST /chat 注入 onTextDelta");
  assert.ok(server.includes("onTaskCreated"), "预期 POST /chat 注入 onTaskCreated");
  assert.ok(server.includes("closeAllChats"), "预期优雅退出会结束在途对话流");

  const mainLoop = read("src/agent/main-loop.ts");
  assert.ok(mainLoop.includes("onTextDelta"), "预期 main-loop options 增 onTextDelta");
  assert.ok(mainLoop.includes("provider.stream"), "预期 main-loop 用 provider.stream 消费增量");
  assert.ok(mainLoop.includes("text_delta"), "预期 main-loop 只转发 text_delta");

  const assembly = read("src/index.ts");
  assert.ok(assembly.includes("mainAi: { provider }"), "预期启动装配注入 mainAi provider");
});

test("M6-03 前端源码：Chat 用 ReadableStream + 24ms 合批；Artifacts 有搜索与抽屉", () => {
  const chat = read("src/web/src/pages/Chat.tsx");
  const chatApi = read("src/web/src/chatApi.ts");
  assert.ok(chat.includes("listMessages("), "预期进入页面拉主线历史");
  assert.ok(chat.includes("streamChat("), "预期发送调用流式接口");
  assert.ok(chatApi.includes('fetch("/chat"'), "预期 POST /chat 用 fetch");
  assert.ok(chatApi.includes("getReader()"), "预期用 ReadableStream 读取 SSE");
  assert.match(chat, /FLUSH_INTERVAL_MS\s*=\s*24/, "预期 delta 合批窗口为 24ms");
  assert.ok(chat.includes("deltaBufferRef.current += delta"), "预期 delta 先入缓冲");
  assert.ok(
    chat.includes("window.setTimeout"),
    "预期用 setTimeout 合批后再 setState，而不是每个 delta 一次",
  );
  assert.ok(chat.includes("setMessages((prev)"), "预期缓冲 flush 后更新消息");
  assert.ok(chat.includes("ReactMarkdown"), "预期 assistant 用 react-markdown 渲染");
  assert.ok(chat.includes("思考中…"), "预期工具轮次期间显示「思考中…」");
  assert.ok(chat.includes("disabled={sending"), "预期请求中禁用发送");

  const artifacts = read("src/web/src/pages/Artifacts.tsx");
  assert.ok(artifacts.includes("searchArtifacts("), "预期产物页调用检索接口");
  assert.ok(artifacts.includes("getArtifact("), "预期抽屉调用单产物详情接口");
  assert.ok(artifacts.includes("<Drawer"), "预期详情用 Drawer");
  assert.ok(artifacts.includes("findings"), "预期抽屉展示 findings");
  assert.ok(artifacts.includes("tags"), "预期卡片/抽屉展示 tags");
  assert.ok(artifacts.includes("trust"), "预期展示 trust 徽标");
  assert.ok(artifacts.includes("onOpenTask"), "预期来源任务可跳任务详情");
});

test("M6-03 依赖：package.json 零新增（与 M6-02 的依赖集合完全一致）", () => {
  const pkg = readJson("package.json");
  const dependencies = asRecord(pkg.dependencies, "package.json dependencies");
  const devDependencies = asRecord(pkg.devDependencies, "package.json devDependencies");

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
    `预期 dependencies 零新增，实际 ${JSON.stringify(Object.keys(dependencies))}`,
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
    `预期 devDependencies 零新增，实际 ${JSON.stringify(Object.keys(devDependencies))}`,
  );
});

// ── 11. 服务端行为：流式对话 / 历史 / 产物详情 ─────────────────

test(
  "M6-03 POST /chat：假 provider 依次产生 delta 与 done，done.reply 完整；GET /messages 读回 user/assistant",
  { timeout: 30_000 },
  async () => {
    await withServerDb(async ({ base, db }) => {
      const provider = new FakeProvider([{ textDeltas: ["你好", "，", "世界"] }]);
      const { scheduler } = stubScheduler();
      const app = createApp({
        db,
        scheduler,
        defaultWorkspace: base,
        mainAi: { provider },
      });
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      assert.ok(address !== null && typeof address === "object", "预期测试服务器返回端口");
      const baseUrl = `http://127.0.0.1:${String(address.port)}`;
      try {
        const response = await fetch(`${baseUrl}/chat`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "text/event-stream" },
          body: JSON.stringify({ message: "帮我看下现在有哪些任务" }),
        });
        assert.equal(response.status, 200, "预期流式响应 HTTP 200");
        assert.match(
          response.headers.get("content-type") ?? "",
          /text\/event-stream/u,
          "预期 Content-Type 为 text/event-stream",
        );

        const frames = parseChatSse(await response.text());
        const deltaFrames = frames.filter((frame) => frame.event === "delta");
        assert.ok(deltaFrames.length >= 1, `预期至少 1 条 delta，实际 ${String(deltaFrames.length)}`);
        const deltas = deltaFrames.map((frame) => {
          const payload = payloadOf(frame, "delta");
          const text = payload.text;
          assert.equal(typeof text, "string", `预期 delta.text 是字符串，实际 ${String(text)}`);
          return text as string;
        });
        assert.equal(deltas.join(""), "你好，世界", "预期 delta 拼接为完整文本");

        const doneFrames = frames.filter((frame) => frame.event === "done");
        assert.equal(doneFrames.length, 1, `预期恰好 1 条 done，实际 ${String(doneFrames.length)}`);
        const done = payloadOf(doneFrames[0], "done");
        assert.equal(done.reply, "你好，世界", "预期 done.reply 是完整文本");
        assert.ok(isRecord(done.usage), `预期 done.usage 是对象，实际 ${String(done.usage)}`);

        const historyResponse = await fetch(`${baseUrl}/messages?limit=10`);
        assert.equal(historyResponse.status, 200);
        const history: unknown = await historyResponse.json();
        assert.ok(Array.isArray(history), `预期 /messages 返回数组，实际 ${String(history)}`);
        const rows = history as Array<Record<string, unknown>>;
        assert.deepEqual(
          rows.map((row) => row.role),
          ["user", "assistant"],
          "预期读回刚写入的 user/assistant 两条主线消息",
        );
        assert.equal(rows[0]?.content, "帮我看下现在有哪些任务");
        assert.equal(rows[1]?.content, "你好，世界");
      } finally {
        await app.close();
      }
    });
  },
);

test(
  "M6-03 POST /chat 流错误：HTTP 仍是 200，先发 error 事件后结束且不发 done",
  { timeout: 30_000 },
  async () => {
    await withServerDb(async ({ base, db }) => {
      const provider = new FakeProvider([{ error: new Error("模拟流式失败") }]);
      const { scheduler } = stubScheduler();
      const app = createApp({
        db,
        scheduler,
        defaultWorkspace: base,
        mainAi: { provider },
      });
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      assert.ok(address !== null && typeof address === "object");
      const baseUrl = `http://127.0.0.1:${String(address.port)}`;
      try {
        const response = await fetch(`${baseUrl}/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "触发失败" }),
        });
        assert.equal(response.status, 200, "预期流内错误仍返回 HTTP 200");
        const frames = parseChatSse(await response.text());
        const errorFrames = frames.filter((frame) => frame.event === "error");
        assert.equal(errorFrames.length, 1, "预期恰好 1 条 error 事件");
        assert.equal(
          frames.some((frame) => frame.event === "done"),
          false,
          "预期错误后不再发 done",
        );
        const payload = payloadOf(errorFrames[0], "error");
        assert.equal(payload.code, "E_INTERNAL", `预期错误码 E_INTERNAL，实际 ${String(payload.code)}`);
      } finally {
        await app.close();
      }
    });
  },
);

test("M6-03 GET /artifacts/:id：返回单产物全量字段；不存在返回 404", async () => {
  await withServerDb(async ({ base, db }) => {
    const { scheduler } = stubScheduler();
    const app = createApp({ db, scheduler, defaultWorkspace: base });
    const task = insertTask(db, { title: "产物来源", goal: "测试", workspace: base });
    const artifact = insertArtifact(db, {
      taskId: task.id,
      kind: "note",
      title: "月度分析结论",
      summary: "本月环比增长 12%，主要来自新客户。",
      tags: ["月度", "环比"],
      findings: ["新客户贡献 8 个百分点"],
      trust: "verified",
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: `/artifacts/${encodeURIComponent(artifact.id)}`,
      });
      assert.equal(response.statusCode, 200);
      const body = asRecord(response.json(), "artifact detail");
      assert.equal(body.id, artifact.id);
      assert.equal(body.title, "月度分析结论");
      assert.deepEqual(body.tags, ["月度", "环比"]);
      assert.deepEqual(body.findings, ["新客户贡献 8 个百分点"]);
      assert.equal(body.trust, "verified");
      assert.equal(body.taskId, task.id);

      const searchResponse = await app.inject({
        method: "GET",
        url: "/artifacts?query=%E6%9C%88%E5%BA%A6%E5%88%86%E6%9E%90",
      });
      assert.equal(searchResponse.statusCode, 200);
      const hits = searchResponse.json();
      assert.ok(Array.isArray(hits));
      assert.ok(
        (hits as Array<Record<string, unknown>>).some((hit) => hit.id === artifact.id),
        "预期中文关键词检索命中产物",
      );

      const missing = await app.inject({ method: "GET", url: "/artifacts/a_missing" });
      assert.equal(missing.statusCode, 404, "预期不存在的产物返回 404");
    } finally {
      await app.close();
    }
  });
});

test(
  "M6-03 优雅退出：app.close 中止在途对话流并结束 HTTP 响应",
  { timeout: 20_000 },
  async () => {
    await withServerDb(async ({ base, db }) => {
      // 5s 延迟确保 close 时 provider 仍在流中；abort 应让其立即退出。
      const provider = new FakeProvider([{ textDeltas: ["迟到的回复"], delayMs: 5_000 }]);
      const { scheduler } = stubScheduler();
      const app = createApp({
        db,
        scheduler,
        defaultWorkspace: base,
        mainAi: { provider },
      });
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      assert.ok(address !== null && typeof address === "object");
      const baseUrl = `http://127.0.0.1:${String(address.port)}`;
      let closed = false;
      try {
        const response = await fetch(`${baseUrl}/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "长回复" }),
        });
        assert.equal(response.status, 200);
        const bodyPromise = response.text();
        const startedAt = Date.now();
        await app.close();
        closed = true;
        const body = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error("app.close 后对话流未在 3s 内结束"));
          }, 3_000);
          bodyPromise.then(
            (value) => {
              clearTimeout(timer);
              resolve(value);
            },
            (error: unknown) => {
              clearTimeout(timer);
              reject(error instanceof Error ? error : new Error(String(error)));
            },
          );
        });
        assert.ok(Date.now() - startedAt < 3_000, "预期 app.close 快速结束在途对话流");
        assert.equal(body.includes("event: done"), false, "预期中止后不再发送 done");
      } finally {
        if (!closed) await app.close();
      }
    });
  },
);

// ── 12. 构建 ───────────────────────────────────────────────────

test("M6-03 构建：pnpm build 退出码 0 且 dist/index.html 存在", { timeout: 240_000 }, () => {
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
