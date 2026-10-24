/**
 * 主线 AI 常驻对话循环（SPEC §4.1 / §4.7 / §7 M5-01）。
 *
 * 一轮 = 写入用户消息 → 组装系统提示 + 最近历史 → 循环调用 provider：
 *   - 每次调用逐条写 llm_calls（purpose='main'，usage 取真值，缺失才估算）
 *     并追加全局 llm.call 事件；
 *   - tool_calls 逐个经 main-tools 执行，成功/失败都回喂给模型；
 *   - 没有 tool_calls 或达到 maxToolRounds 即结束，最终回复落 messages。
 *
 * 边界：
 *   - 主线不直接执行文件/命令，所有副作用只能通过 create_task 派活
 *     （main-tools 也不 import 任何文件或子进程模块）；
 *   - 达到工具轮上限时返回已积累文本 + [已达工具轮上限] 说明，不抛错；
 *   - ask_user 是主线控制流：直接把问题作为本轮回复，不进入 waiting_input。
 */
import type { DatabaseSync } from 'node:sqlite';

import { ContractError, ERROR_CODES } from '../core/errors.ts';
import {
  llmContentText,
  type LlmMessage,
  type LlmResponse,
  type Task,
  type TokenUsage,
  type ToolSpec,
} from '../core/types.ts';
import {
  estimateTokenUsage,
  type ChatParams,
  type LlmProvider,
} from '../providers/types.ts';
import type { TaskCanceller } from '../runtime/ops.ts';
import { appendEvent } from '../store/events.ts';
import { insertLlmCall } from '../store/llm-calls.ts';
import { appendMessage, type MessageAttachment } from '../store/messages.ts';
import { getSettings, resolveDefaultWorkspace } from '../store/settings.ts';
import { buildMainContext, gatherMainContext } from './context.ts';
import {
  executeMainTool,
  MAIN_TOOL_SPECS,
  type MainToolOptions,
  type MainToolResult,
} from './main-tools.ts';

export const MAIN_MODEL = 'deepseek-chat';
export const DEFAULT_MAIN_HISTORY_TURNS = 12;
export const DEFAULT_MAIN_MAX_TOOL_ROUNDS = 10;

/**
 * 附录 B 主线系统提示骨架（5 条）+ M7-02 来源引用硬规则（第 6 条）。
 * M5-02 会在此之上注入长期事实/看板/产物摘要，本卡只做骨架 + 最近历史。
 */
export const MAIN_SYSTEM_PROMPT = [
  '你是用户的任务台主控。你的职责是理解需求、决定是否建任务、汇报结果。',
  '规则：',
  '1. 需要实际动手（读写文件、运行命令、分析数据）时，必须调用 create_task，不要自己执行。',
  '2. 汇报任务结果时只引用【产物摘要】；需要细节时先 search_artifacts 再 read_artifact。',
  '3. 摘要不等于事实。未经 read_artifact 确认的结论，要说明是"根据摘要"。',
  '4. 不确定用户的意图时，先 ask_user，不要猜。',
  '5. 回答用中文，简洁。',
  '6. 引用任何产物结论时，必须同时给出它的来源任务 ID（source_task_id）；未经 read_artifact 核对的，注明"根据摘要"。',
  '7. 对话历史里的 [图片 …] / [附件 …] 标记表示该内容在当轮已真实送达并被你查看过（历史回放不重发本体）；基于它的当时回答是有效的，不要因为现在看不到原图就否认或撤回当时的结论。',
  '8. 用户询问任务进展/进度/执行到哪了时，调用 get_task 并向用户转述 progress（第几步/共几步、正在执行的工具、已耗时、token 消耗占预算），不要编造未在 progress 里的细节。',
].join('\n');

/** 与子智能体工具表一起导出，便于装配层/测试断言十件套。 */
export const MAIN_TOOL_NAMES: readonly string[] = MAIN_TOOL_SPECS.map((spec) => spec.name);

/** 主线十件套直接复用 main-tools 的声明。 */
export const MAIN_TOOLS: ToolSpec[] = MAIN_TOOL_SPECS;

export interface MainTurnUsage {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  /** input + output；cached 是 input 的子集，不重复计入。 */
  totalTokens: number;
}

export interface MainToolTraceEntry {
  /** 第几轮工具调用（从 1 开始）。 */
  round: number;
  tool: string;
  /** 解析后的参数；参数 JSON 非法时为原始字符串。 */
  args: unknown;
  ok: boolean;
  output: string;
  code?: string;
  ms: number;
  /** ask_user 的主线语义标记。 */
  decision?: string;
}

export interface MainTurnResult {
  reply: string;
  toolTrace: MainToolTraceEntry[];
  usage: MainTurnUsage;
}

export interface RunMainTurnOptions {
  db: DatabaseSync;
  provider: LlmProvider;
  /**
   * 纯文本入参；与 userContent 二选一。
   * 都给/都不给时抛 E_INVALID_ARGUMENT（参数契约错误，不是 500）。
   */
  userMessage?: string;
  /**
   * 多模态入参（M9-03）：当前轮原样进 provider；历史轮统一折纯文本。
   * 传字符串与 userMessage 等价，传数组时用于图片 data URL 分片。
   */
  userContent?: LlmMessage['content'];
  /**
   * 落库/展示用纯文本；缺省取 llmContentText(userContent)。
   * 附件正文只进当前轮 provider content，不进 messages（避免历史重复计价）。
   */
  userText?: string;
  /** 当前轮附件元数据；只落库，不进入 provider 上下文。 */
  userAttachments?: readonly MessageAttachment[];
  /** 最近历史轮数（user+assistant 为一轮）；默认 12。 */
  historyLimit?: number;
  /** 工具调用轮上限；默认 10，防止失控。 */
  maxToolRounds?: number;
  signal?: AbortSignal;
  /** create_task / retry_task 后的调度唤醒，由装配层接 scheduler.tick。 */
  onTaskCreated?: (task: Task) => void | Promise<void>;
  /** cancel_task 的 abort 能力；可省略。 */
  scheduler?: TaskCanceller | null;
  /** create_task 的默认工作区；缺省 resolveDefaultWorkspace(db)（settings > env > <repo>/workspace）。 */
  workspace?: string;
  /** note 产物正文根目录；默认 <cwd>/data/artifacts，测试/装配层可注入。 */
  artifactsDir?: string;
  /** 可注入时钟（毫秒时间戳）；默认 Date.now。 */
  now?: () => number;
  /** 模型名；缺省取当前设置 main.model。 */
  model?: string;
  /** 以下四项缺省取当前设置 main.*；调用方显式传入优先。 */
  reasoningEffort?: 'low' | 'medium' | 'high';
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  /**
   * 文本增量转发（M6-03）。提供时本轮 provider 调用走 `stream`，
   * 仅在 `done` 后把完整响应交给循环；缺省时仍走 `chat`，保持 M5 行为不变。
   */
  onTextDelta?: (text: string) => void;
}

interface MutableUsage {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
}

function nonNegativeInteger(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function addUsage(target: MutableUsage, usage: TokenUsage): void {
  target.inputTokens += nonNegativeInteger(usage.inputTokens);
  target.cachedTokens += nonNegativeInteger(usage.cachedTokens);
  target.outputTokens += nonNegativeInteger(usage.outputTokens);
}

function snapshotUsage(usage: MutableUsage): MainTurnUsage {
  return {
    inputTokens: usage.inputTokens,
    cachedTokens: usage.cachedTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.inputTokens + usage.outputTokens,
  };
}

function normalizeHistoryTurns(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAIN_HISTORY_TURNS;
  return Math.max(0, Math.floor(value));
}

function normalizeMaxToolRounds(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAIN_MAX_TOOL_ROUNDS;
  return Math.max(0, Math.floor(value));
}

function parseToolArguments(
  raw: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const text = raw.trim();
  if (text.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: '参数不是合法 JSON，请检查引号、逗号与括号' };
  }
}

function formatToolOutput(result: MainToolResult): string {
  if (result.ok) {
    return result.output.length > 0 ? result.output : '(工具执行成功，无输出)';
  }
  if (result.output.length > 0) return result.output;
  const code = result.error?.code ?? 'E_TOOL_FAILED';
  const message = result.error?.message ?? '工具执行失败';
  return `[工具失败] ${code}: ${message}`;
}

/** 参数 JSON 非法时也按“工具失败”回喂，并留一条 trace。 */
function invalidToolArguments(tool: string, message: string): MainToolResult {
  return {
    ok: false,
    tool,
    output: `[工具失败] ${ERROR_CODES.E_INVALID_ARGUMENT}: ${tool} ${message}`,
    error: { code: ERROR_CODES.E_INVALID_ARGUMENT, message: `${tool} ${message}` },
  };
}

/**
 * 统一 provider 调用出口：没有增量回调时沿用 chat；有回调时改用 stream，
 * 把 text_delta 转发给调用方，并等 done 事件返回完整响应。
 *
 * 注意：不能在 stream 失败时静默退回 chat——那会让同一个用户请求可能被
 * 计费两次，也会掩盖真实的网络/鉴权错误。这里只按“是否要求流式”二选一。
 */
async function requestProviderResponse(
  provider: LlmProvider,
  params: ChatParams,
  onTextDelta: ((text: string) => void) | undefined,
): Promise<LlmResponse> {
  if (onTextDelta === undefined) {
    return provider.chat(params);
  }

  let response: LlmResponse | null = null;
  for await (const event of provider.stream(params)) {
    if (event.type === 'text_delta') {
      if (event.text.length > 0) onTextDelta(event.text);
      continue;
    }
    if (event.type === 'done') {
      response = event.response;
    }
  }
  if (response === null) {
    throw new ContractError(ERROR_CODES.E_INTERNAL, 'provider.stream 未返回 done 事件');
  }
  return response;
}

/**
 * 执行一轮主线对话。
 *
 * 失败语义：provider/abort 异常向上抛出（已先记账）；工具失败只回喂，
 * 工具轮上限只返回带标注的回复。主线的“对话不该炸”仅指上限路径。
 */
export async function runMainTurn(options: RunMainTurnOptions): Promise<MainTurnResult> {
  const { db, provider } = options;
  const clock = options.now ?? Date.now;
  // 每轮对话读一次设置：运行中修改设置后，下一轮立即生效（无需重启）。
  const roleSettings = getSettings(db).main;
  const model = options.model ?? roleSettings.model;
  const reasoningEffort =
    options.reasoningEffort ??
    (roleSettings.thinkingLevel === 'off' ? undefined : roleSettings.thinkingLevel);
  const temperature = options.temperature ?? roleSettings.temperature;
  const topP = options.topP ?? roleSettings.topP;
  const maxTokens = options.maxTokens ?? roleSettings.maxTokens;
  const maxToolRounds = normalizeMaxToolRounds(options.maxToolRounds);
  const historyTurns = normalizeHistoryTurns(options.historyLimit);

  // userMessage / userContent 严格二选一：调用方拼错参数时不能静默选一个。
  const hasUserMessage = options.userMessage !== undefined;
  const hasUserContent = options.userContent !== undefined;
  if (hasUserMessage === hasUserContent) {
    throw new ContractError(
      ERROR_CODES.E_INVALID_ARGUMENT,
      'userMessage 与 userContent 必须二选一提供',
    );
  }
  const currentContent: LlmMessage['content'] = hasUserContent
    ? options.userContent!
    : options.userMessage!;
  // 落库文本优先用调用方给的展示文本；否则取分片的纯文本视图（图片折 [图片]）。
  const currentText = options.userText ?? llmContentText(currentContent);

  const toolOptions: MainToolOptions = {
    db,
    workspace: options.workspace ?? resolveDefaultWorkspace(db),
    ...(options.onTaskCreated === undefined
      ? {}
      : { onTaskCreated: options.onTaskCreated }),
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
    ...(options.artifactsDir === undefined ? {} : { artifactsDir: options.artifactsDir }),
    now: clock,
  };

  // 1. 用户消息先落库；历史窗口包含本条消息。
  appendMessage(db, {
    role: 'user',
    content: currentText,
    ...(options.userAttachments === undefined || options.userAttachments.length === 0
      ? {}
      : { attachments: options.userAttachments }),
    ts: clock(),
  });

  const gathered = gatherMainContext(db, {
    userMessage: currentText,
    historyLimit: historyTurns,
  });
  const messages: LlmMessage[] = buildMainContext(db, {
    ...gathered,
    systemPrompt: MAIN_SYSTEM_PROMPT,
  });

  // 历史只保留纯文本：非当前轮即使存了图片分片也不再重发（控 token）。
  // 当前轮（最后一条 user）恢复调用方给的原样 content（可能含图片分片）。
  const lastIndex = messages.length - 1;
  const last = messages[lastIndex];
  if (last !== undefined && last.role === 'user') {
    for (let index = 0; index < lastIndex; index += 1) {
      const message = messages[index];
      if (message !== undefined) {
        messages[index] = { ...message, content: llmContentText(message.content) };
      }
    }
    messages[lastIndex] = { ...last, content: currentContent };
  } else {
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (message !== undefined) {
        messages[index] = { ...message, content: llmContentText(message.content) };
      }
    }
    messages.push({ role: 'user', content: currentContent });
  }

  const usage: MutableUsage = { inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
  const toolTrace: MainToolTraceEntry[] = [];
  let accumulated = '';
  let reply = '';
  let capped = false;
  let toolRounds = 0;
  let firstCall = true;

  const recordLlmCall = (measured: TokenUsage, latencyMs: number): void => {
    const ts = clock();
    insertLlmCall(db, {
      taskId: null,
      runId: null,
      purpose: 'main',
      model,
      inputTokens: nonNegativeInteger(measured.inputTokens),
      cachedTokens: nonNegativeInteger(measured.cachedTokens),
      outputTokens: nonNegativeInteger(measured.outputTokens),
      latencyMs,
      estimated: measured.estimated === true,
      ts,
    });
    appendEvent(db, {
      type: 'llm.call',
      actor: 'system',
      payload: {
        model,
        in: nonNegativeInteger(measured.inputTokens),
        cached: nonNegativeInteger(measured.cachedTokens),
        out: nonNegativeInteger(measured.outputTokens),
        ms: latencyMs,
      },
      ts,
    });
  };

  for (;;) {
    // maxToolRounds 限制的是「已执行的工具轮」：执行满后不再发下一次调用，
    // 直接带着已积累文本收口（maxToolRounds=0 仍允许一次纯文本调用）。
    if (!firstCall && toolRounds >= maxToolRounds) {
      capped = true;
      break;
    }
    firstCall = false;

    const callStartedAt = Date.now();
    let response: LlmResponse;
    try {
      const params: ChatParams = {
        // 快照：后续轮次追加 tool 消息不应改变本次调用记录。
        messages: [...messages],
        tools: MAIN_TOOL_SPECS,
        model,
        temperature,
        topP,
        maxTokens,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        toolChoice: 'auto',
      };
      response = await requestProviderResponse(provider, params, options.onTextDelta);
    } catch (error) {
      // SPEC §4.8：失败的调用也记账（usage 未知记 0）。
      recordLlmCall(
        { inputTokens: 0, cachedTokens: 0, outputTokens: 0, estimated: false },
        Math.max(0, Date.now() - callStartedAt),
      );
      throw error;
    }
    const latencyMs = Math.max(0, Date.now() - callStartedAt);
    const measured =
      response.usage ?? estimateTokenUsage(messages, response.content, response.toolCalls);
    addUsage(usage, measured);
    recordLlmCall(measured, latencyMs);

    const text = response.content ?? '';
    if (text.length > 0) {
      accumulated = accumulated.length > 0 ? `${accumulated}\n${text}` : text;
    }

    if (response.toolCalls.length === 0) {
      reply = accumulated;
      break;
    }

    // maxToolRounds=0 或已执行满上限：保留本次文本，丢弃未执行的调用。
    if (toolRounds >= maxToolRounds) {
      capped = true;
      break;
    }

    toolRounds += 1;
    messages.push({ role: 'assistant', content: text, toolCalls: response.toolCalls });

    let askReply: string | null = null;
    for (const call of response.toolCalls) {
      const toolStartedAt = Date.now();
      const parsed = parseToolArguments(call.function.arguments);
      const argsForTrace: unknown = parsed.ok ? parsed.value : call.function.arguments;
      const result = parsed.ok
        ? await executeMainTool(call.function.name, parsed.value, toolOptions)
        : invalidToolArguments(call.function.name, parsed.error);
      const ms = Math.max(0, Date.now() - toolStartedAt);

      toolTrace.push({
        round: toolRounds,
        tool: call.function.name,
        args: argsForTrace,
        ok: result.ok,
        output: result.output,
        ...(result.error === undefined ? {} : { code: result.error.code }),
        ms,
        ...(result.decision === undefined ? {} : { decision: result.decision }),
      });
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        content: formatToolOutput(result),
      });

      // ask_user 直接结束本轮：不转 waiting_input，不再让模型多答一轮。
      if (result.ok && result.reply !== undefined) {
        askReply = result.reply;
        break;
      }
    }

    if (askReply !== null) {
      reply = askReply;
      break;
    }
  }

  if (capped) {
    const note =
      `[已达工具轮上限] 已执行 ${toolRounds} 轮工具调用。` +
      '本轮先返回已有内容；如仍需继续，请再发消息或调整目标。';
    reply = accumulated.length > 0 ? `${accumulated}\n\n${note}` : note;
  }

  // 2. 最终回复落库；tokens 记本轮 output 总量（单次调用时等于该次 usage.out）。
  appendMessage(db, {
    role: 'assistant',
    content: reply,
    tokens: usage.outputTokens,
    ts: clock(),
  });

  return { reply, toolTrace, usage: snapshotUsage(usage) };
}
