/**
 * DeepSeek 手动实测脚本（不属于 verify，不打测试 API）
 *
 * 用法：
 *   1. 复制 .env.example 为 .env 并填入 DEEPSEEK_API_KEY，或直接设置环境变量；
 *   2. node scripts/spike-deepseek.ts
 *
 * 安全：只打印响应结构 / usage，绝不打印 API key 或 Authorization 头。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ContractError } from "../src/core/errors.ts";
import type { LlmToolCall, TokenUsage, ToolSpec } from "../src/core/types.ts";
import { DeepSeekProvider } from "../src/providers/deepseek.ts";

interface SpikeResult {
  name: string;
  ok: boolean;
  error?: string;
}

const results: SpikeResult[] = [];

function loadDotEnv(): void {
  const file = join(process.cwd(), ".env");
  if (!existsSync(file)) return;
  const content = readFileSync(file, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function printUsage(label: string, usage: TokenUsage | undefined): void {
  if (usage === undefined) {
    console.log(`${label} usage: 缺失`);
    return;
  }
  console.log(
    `${label} usage: input=${usage.inputTokens} cached=${usage.cachedTokens} output=${usage.outputTokens} estimated=${usage.estimated}`,
  );
}

function printToolCalls(toolCalls: LlmToolCall[]): void {
  if (toolCalls.length === 0) {
    console.log("toolCalls: （模型未发起工具调用）");
    return;
  }
  for (const call of toolCalls) {
    console.log(
      `toolCall: id=${call.id} name=${call.function.name} arguments=${call.function.arguments}`,
    );
    try {
      console.log("  parsed:", JSON.parse(call.function.arguments) as unknown);
    } catch {
      console.log("  parsed: 非法 JSON（按原文记录）");
    }
  }
}

async function runStep(
  name: string,
  fn: () => Promise<void>,
): Promise<void> {
  console.log(`\n=== ${name} ===`);
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    const message =
      error instanceof ContractError
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    results.push({ name, ok: false, error: message });
    console.error(`${name} 失败：${message}`);
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    console.error(
      "缺少 DEEPSEEK_API_KEY。请设置环境变量，或在仓库根目录创建 .env（可从 .env.example 复制）。",
    );
    process.exitCode = 1;
    return;
  }

  const provider = new DeepSeekProvider({ apiKey });
  const tools: ToolSpec[] = [
    {
      name: "get_weather",
      description: "查询指定城市的当前天气",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "城市名，例如 北京" },
        },
        required: ["city"],
      },
    },
  ];

  await runStep("1. 非流式一句话", async () => {
    const response = await provider.chat({
      messages: [{ role: "user", content: "用一句话介绍你自己。" }],
    });
    console.log("content:", response.content);
    console.log("finishReason:", response.finishReason);
    printUsage("chat", response.usage);
  });

  await runStep("2. 流式一句话", async () => {
    let text = "";
    let finalUsage: TokenUsage | undefined;
    let finalText = "";
    for await (const event of provider.stream({
      messages: [{ role: "user", content: "用一句话说明流式输出是什么。" }],
    })) {
      if (event.type === "text_delta") {
        text += event.text;
        process.stdout.write(event.text);
      } else if (event.type === "done") {
        finalText = event.response.content ?? "";
        finalUsage = event.response.usage;
      }
    }
    process.stdout.write("\n");
    console.log("stream 拼接文本:", text);
    console.log("最终 content:", finalText);
    printUsage("stream", finalUsage);
  });

  await runStep("3. 一次 tool 调用", async () => {
    const response = await provider.chat({
      messages: [
        {
          role: "user",
          content: "北京现在天气怎么样？请调用 get_weather 工具查询。",
        },
      ],
      tools,
    });
    console.log("content:", response.content);
    console.log("finishReason:", response.finishReason);
    printToolCalls(response.toolCalls);
    printUsage("tool", response.usage);
  });

  await runStep("4. /user/balance", async () => {
    const balance = await provider.checkBalance();
    console.log("isAvailable:", balance.isAvailable);
    console.log("balances:", JSON.stringify(balance.balances, null, 2));
  });

  const failed = results.filter((result) => !result.ok);
  console.log("\n=== 汇总 ===");
  for (const result of results) {
    console.log(
      `${result.ok ? "PASS" : "FAIL"}  ${result.name}${result.error === undefined ? "" : ` -> ${result.error}`}`,
    );
  }
  if (failed.length > 0) {
    console.error(`\n${failed.length} 项失败，请把上面的错误原文交给 Manager。`);
    process.exitCode = 1;
  } else {
    console.log("\n全部实测项完成。");
  }
}

main().catch((error: unknown) => {
  console.error(
    "spike 脚本异常退出：",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
