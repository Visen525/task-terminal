/**
 * v1.5 三卡验收（SPEC §10 M13-01..03）。
 *
 * M13-01 内置默认系统提示词完整重写：使命/十件套/注入上下文/硬规则/约定，
 *   且与前端 Settings.tsx 预填文案逐字一致。
 * M13-02 主线思考过程可视化：FakeProvider/DeepSeek 思考分片 → runMainTurn
 *   转发与落库 → SSE reasoning 帧 → GET /messages 回放。
 * M13-03 选项卡片：解析器 title 捕获、内联代码保留、发送值去反引号。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";

import { MAIN_SYSTEM_PROMPT, runMainTurn } from "../../src/agent/main-loop.ts";
import { DeepSeekProvider } from "../../src/providers/deepseek.ts";
import { FakeProvider } from "../../src/providers/fake.ts";
import type { LlmStreamEvent } from "../../src/providers/types.ts";
import { createApp } from "../../src/server/index.ts";
import type { Scheduler } from "../../src/runtime/scheduler.ts";
import { appendMessage, listRecentMessages } from "../../src/store/messages.ts";
import { openDatabase } from "../../src/store/migrate.ts";
import { parseOptionGroups, optionSendValue } from "../../src/web/src/components/optionParse.ts";

const root = join(import.meta.dirname, "..", "..");

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

// ════════════════════════════════════════════════════════════════
// M13-01 内置默认系统提示词
// ════════════════════════════════════════════════════════════════

test("M13-01 内置提示词：使命、十件套、注入上下文、硬规则、约定齐备", () => {
  // 十件套逐项出现。
  for (const tool of [
    "create_task",
    "get_task",
    "list_tasks",
    "cancel_task",
    "retry_task",
    "search_artifacts",
    "read_artifact",
    "remember",
    "recall",
    "ask_user",
  ]) {
    assert.ok(
      MAIN_SYSTEM_PROMPT.includes(`- ${tool}：`),
      `预期提示词逐项介绍工具 ${tool}`,
    );
  }
  // 章节与关键规则锚点。
  for (const marker of [
    "## 使命",
    "## 你可以使用的工具",
    "## 每轮自动注入的上下文",
    "## 汇报与引用（硬规则）",
    "## 对话约定",
    "引用任何产物结论时，必须同时给出来源任务 ID（source_task_id）",
    "根据摘要",
    "主动引用产物",
    "（第几步/共几步、正在执行的工具、已耗时、token 消耗占预算）",
    "[图片 …] / [附件 …]",
    "不直接执行任何文件或命令操作",
    "用 A. B. C. … 的格式每行一项列出",
  ]) {
    assert.ok(MAIN_SYSTEM_PROMPT.includes(marker), `预期提示词包含 ${marker}`);
  }
  // 不超过设置页 8000 字上界。
  assert.ok(
    [...MAIN_SYSTEM_PROMPT].length <= 8000,
    "预期内置提示词 ≤8000 字符",
  );
});

test("M13-01 前端预填文案：Settings.tsx 与内置提示词逐行一致", () => {
  const settings = read("src/web/src/pages/Settings.tsx");
  for (const line of MAIN_SYSTEM_PROMPT.split("\n")) {
    const escaped = line.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
    assert.ok(
      settings.includes(`"${escaped}"`),
      `预期前端内置提示同步：${line.slice(0, 24)}…`,
    );
  }
});

// ════════════════════════════════════════════════════════════════
// M13-02 思考过程可视化
// ════════════════════════════════════════════════════════════════

test("M13-02 消息仓储：reasoning 随 content JSON 落库/读回，空串与缺省不产生字段", () => {
  const db = openDatabase(":memory:");
  try {
    appendMessage(db, {
      role: "assistant",
      content: "结论是 A",
      reasoning: "先排除 B，再比较 A/C",
      ts: 1_000,
    });
    appendMessage(db, { role: "user", content: "为什么", ts: 1_100 });
    appendMessage(db, { role: "assistant", content: "因为", reasoning: "", ts: 1_200 });

    const rows = listRecentMessages(db, 10);
    assert.equal(rows.length, 3);
    assert.equal(rows[0]?.reasoning, "先排除 B，再比较 A/C");
    assert.equal(rows[1]?.reasoning, undefined);
    assert.equal(rows[2]?.reasoning, undefined, "空串视同缺省");

    // 附件与 reasoning 可共存。
    appendMessage(db, {
      role: "assistant",
      content: "带附件",
      reasoning: "看过图再答",
      attachments: [
        { id: "u_1", name: "a.png", mime: "image/png", size: 3, path: "data/uploads/u_1__a.png" },
      ],
      ts: 1_300,
    });
    const withBoth = listRecentMessages(db, 1)[0];
    assert.equal(withBoth?.reasoning, "看过图再答");
    assert.equal(withBoth?.attachments?.length, 1);
  } finally {
    db.close();
  }
});

test("M13-02 runMainTurn：思考分片转发 onReasoningDelta，并随最终回复落库", async () => {
  const base = mkdtempSync(join(tmpdir(), "task-terminal-m13-"));
  const db = openDatabase(":memory:");
  try {
    const provider = new FakeProvider([
      {
        content: "答案是 C",
        reasoningDeltas: ["先看边界", "，再排除", "A/B"],
      },
    ]);
    const reasoningChunks: string[] = [];
    const result = await runMainTurn({
      db,
      provider,
      userMessage: "哪一项正确？",
      onTextDelta: () => {},
      onReasoningDelta: (text) => {
        reasoningChunks.push(text);
      },
      now: () => 2_000,
    });
    assert.equal(reasoningChunks.join(""), "先看边界，再排除A/B");
    assert.equal(result.reply, "答案是 C");

    const [assistant] = listRecentMessages(db, 1);
    assert.equal(assistant?.role, "assistant");
    assert.equal(assistant?.reasoning, "先看边界，再排除A/B");
  } finally {
    db.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test("M13-02 runMainTurn：非流式路径从 response.reasoningContent 兜底落库", async () => {
  const db = openDatabase(":memory:");
  try {
    const provider = new FakeProvider([
      { content: "好的", reasoningDeltas: ["想了一下"] },
    ]);
    await runMainTurn({
      db,
      provider,
      userMessage: "在吗",
      now: () => 3_000,
    });
    const [assistant] = listRecentMessages(db, 1);
    assert.equal(assistant?.reasoning, "想了一下");
  } finally {
    db.close();
  }
});

test("M13-02 FakeProvider：reasoningDeltas 先于 text 产出且 done 带 reasoningContent", async () => {
  const provider = new FakeProvider([
    { content: "正文", reasoningDeltas: ["思", "考"] },
  ]);
  const events: LlmStreamEvent[] = [];
  for await (const event of provider.stream({ messages: [] })) {
    events.push(event);
  }
  const kinds = events.map((event) => event.type);
  assert.deepEqual(
    kinds.filter((type) => type !== "done"),
    ["reasoning_delta", "reasoning_delta", "text_delta"],
    "预期思考分片先于正文",
  );
  const done = events.at(-1);
  assert.ok(done !== undefined && done.type === "done");
  assert.equal(done.response.reasoningContent, "思考");
});

interface MockServer {
  baseUrl: string;
  close: () => Promise<void>;
}

async function startMockServer(
  handler: (response: ServerResponse) => void,
): Promise<MockServer> {
  const server = createServer((request, response) => {
    request.on("data", () => {});
    request.on("end", () => {
      handler(response);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

test("M13-02 DeepSeek 适配器：流式解析 delta.reasoning_content 并计入首 token", async () => {
  const server = await startMockServer((response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(sseFrame({
      choices: [{ delta: { role: "assistant", reasoning_content: "先想" } }],
    }));
    response.write(sseFrame({
      choices: [{ delta: { reasoning_content: "一步" } }],
    }));
    response.write(sseFrame({ choices: [{ delta: { content: "答案" } }] }));
    response.write(sseFrame({
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 0 },
    }));
    response.end("data: [DONE]\n\n");
  });
  try {
    const provider = new DeepSeekProvider({ apiKey: "sk-test", baseUrl: server.baseUrl });
    const reasoning: string[] = [];
    const text: string[] = [];
    let doneReasoning: string | undefined;
    for await (const event of provider.stream({ messages: [{ role: "user", content: "q" }] })) {
      if (event.type === "reasoning_delta") reasoning.push(event.text);
      if (event.type === "text_delta") text.push(event.text);
      if (event.type === "done") doneReasoning = event.response.reasoningContent;
    }
    assert.equal(reasoning.join(""), "先想一步");
    assert.equal(text.join(""), "答案");
    assert.equal(doneReasoning, "先想一步");
  } finally {
    await server.close();
  }
});

test("M13-02 DeepSeek 适配器：非流式读取 message.reasoning_content", async () => {
  const server = await startMockServer((response) => {
    const body = JSON.stringify({
      choices: [
        {
          message: { role: "assistant", content: "答", reasoning_content: "思" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 2, prompt_cache_hit_tokens: 0 },
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(body);
  });
  try {
    const provider = new DeepSeekProvider({ apiKey: "sk-test", baseUrl: server.baseUrl });
    const response = await provider.chat({ messages: [{ role: "user", content: "q" }] });
    assert.equal(response.reasoningContent, "思");
  } finally {
    await server.close();
  }
});

test("M13-02 POST /chat SSE：reasoning 帧先于 delta；GET /messages 回放 reasoning", { timeout: 30_000 }, async () => {
  const base = mkdtempSync(join(tmpdir(), "task-terminal-m13-srv-"));
  mkdirSync(join(base, "ws"));
  const db = openDatabase(":memory:");
  const scheduler: Scheduler = {
    tick: async () => ({ started: false, reason: "empty" }),
    runAll: async () => [],
    shutdown: async () => undefined,
    cancel: () => false,
  };
  const provider = new FakeProvider([
    { content: "正文答案", reasoningDeltas: ["思考 A", "思考 B"] },
  ]);
  const app = createApp({ db, scheduler, defaultWorkspace: base, mainAi: { provider } });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address !== null && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${String(address.port)}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ message: "出个题" }),
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    const frames = body
      .split("\n\n")
      .filter((block) => block.trim().length > 0 && !block.startsWith(":"))
      .map((block) => {
        let event = "message";
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /u, ""));
        }
        return { event, data: data.length > 0 ? data.join("\n") : null };
      });

    const reasoningFrames = frames.filter((frame) => frame.event === "reasoning");
    assert.equal(reasoningFrames.length, 2, "预期两条 reasoning 帧");
    const firstReasoning = reasoningFrames[0];
    const firstDeltaIndex = frames.findIndex((frame) => frame.event === "delta");
    const firstReasoningIndex = frames.findIndex((frame) => frame.event === "reasoning");
    assert.ok(
      firstReasoningIndex >= 0 && firstDeltaIndex > firstReasoningIndex,
      "预期 reasoning 帧先于 delta 帧",
    );
    const reasoningPayload: unknown = JSON.parse(firstReasoning?.data ?? "{}");
    assert.deepEqual(reasoningPayload, { text: "思考 A" });

    const historyResponse = await fetch(`http://127.0.0.1:${String(address.port)}/messages?limit=10`);
    const history: unknown = await historyResponse.json();
    assert.ok(Array.isArray(history));
    const assistant = (history as Array<Record<string, unknown>>).at(-1);
    assert.equal(assistant?.role, "assistant");
    assert.equal(assistant?.reasoning, "思考 A思考 B");
  } finally {
    await app.close();
    db.close();
    rmSync(base, { recursive: true, force: true });
  }
});

// ════════════════════════════════════════════════════════════════
// M13-03 选项卡片
// ════════════════════════════════════════════════════════════════

test("M13-03 解析器：组前短行成为 title，长行/选项行不产生 title", () => {
  const groups = parseOptionGroups(
    ["哪一个赋值会触发异常？", "A. s.score = 0", "B. s.score = 100", "C. s.score = -1", ""].join("\n"),
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.title, "哪一个赋值会触发异常？");
  assert.equal(groups[0]?.items.length, 3);

  const noTitle = parseOptionGroups(
    ["这一行特别长".repeat(20), "A. 甲", "B. 乙"].join("\n"),
  );
  assert.equal(noTitle[0]?.title, undefined, "超长标题行不作为 title");

  const bare = parseOptionGroups(["A. 甲", "B. 乙"].join("\n"));
  assert.equal(bare[0]?.title, undefined, "消息开头直接是选项时无 title");
});

test("M13-03 解析器：内联代码反引号保留、markdown 加粗剥除、发送值去反引号", () => {
  const groups = parseOptionGroups(["A. `s.score = 0`", "B. **满分**"].join("\n"));
  assert.equal(groups[0]?.items[0]?.text, "`s.score = 0`");
  assert.equal(groups[0]?.items[1]?.text, "满分");
  assert.equal(optionSendValue("`s.score = 0`"), "s.score = 0");
});

test("M13-03 解析器：四种序号回归（A/1/①/（一））不受升级影响", () => {
  const latin = parseOptionGroups(["A. 甲", "B. 乙"].join("\n"));
  assert.equal(latin[0]?.kind, "latin");
  const number = parseOptionGroups(["1. 甲", "2. 乙"].join("\n"));
  assert.equal(number[0]?.kind, "number");
  const circled = parseOptionGroups(["① 甲", "② 乙"].join("\n"));
  assert.equal(circled[0]?.kind, "circled");
  const chinese = parseOptionGroups(["（一）甲", "（二）乙"].join("\n"));
  assert.equal(chinese[0]?.kind, "chinese");
  assert.ok(latin.every((group) => group.items.length === 2));
});
