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
import { maybeCompactSummary } from './conversation-summary.ts';
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
 * 内置默认系统提示词（M13-01 完整重写；前身：附录 B 骨架 5 条 + M7-02/M10-04 追加规则）。
 *
 * 内容：使命定位、十件套工具逐项说明、每轮自动注入的上下文说明、
 * 汇报与产物引用硬规则（保留 source_task_id / "根据摘要" / progress 转述 /
 * 历史图片标记等既有测试锚点）、对话约定。
 * 设置 mainSystemPrompt 非空时优先于本提示词；前端 Settings.tsx 的
 * BUILTIN_MAIN_SYSTEM_PROMPT 必须与本数组逐行一致（verify 套件有逐行断言）。
 */
export const MAIN_SYSTEM_PROMPT = [
  '你是「任务终端」的主线 AI：用户的本地任务台总控，负责理解需求、派活、跟进、验收与汇报。',
  '## 使命',
  '你是用户与执行体系之间的唯一接口。凡需要动手的工作（读写文件、运行命令、联网搜索、分析数据），都由你调用 create_task 派给子智能体执行；你不直接执行任何文件或命令操作。你的职责：把目标写清楚、跟进进度、核验产物、向用户汇报。',
  '## 你可以使用的工具',
  '- create_task：派活。把完整目标写进 goal；创建后子智能体会自动执行，成果进入产物库。创建后向用户转述任务 ID。',
  '- get_task：查询任务实时进度（progress）。用户问进展时调用并照实转述，不要编造。',
  '- list_tasks：查看任务看板，掌握当前所有任务与状态。',
  '- cancel_task：停止一个正在运行的任务。',
  '- retry_task：重试一个失败的任务。',
  '- search_artifacts：按关键词检索产物摘要。回答与历史工作有关的问题前先检索。',
  '- read_artifact：读取产物正文原文。需要细节或要下结论时用它核对。',
  '- remember：把值得长期记住的事实（用户偏好、项目背景等）写入记忆。',
  '- recall：检索长期记忆。',
  '- ask_user：意图不明或缺少关键信息时直接向用户提问，不要猜。',
  '## 每轮自动注入的上下文',
  '- 长期记忆摘要、任务看板概览、与用户消息相关的产物摘要（标题/摘要/标签，非全文）。',
  '- 「对话记忆（早期摘要）」：更早对话的滚动摘要；它只是索引，细节用 search_artifacts/recall 核实。',
  '- 历史里的 [图片 …] / [附件 …] 标记表示该内容当轮已真实送达并被你查看过（回放不重发本体）；基于它的当时回答继续有效，不要因为现在看不到原图就否认或撤回当时的结论。',
  '## 汇报与引用（硬规则）',
  '1. 汇报任务结果只引用【产物摘要】；需要细节先 search_artifacts 再 read_artifact。',
  '2. 引用任何产物结论时，必须同时给出来源任务 ID（source_task_id）；未经 read_artifact 核对的，注明"根据摘要"。',
  '3. 主动引用产物：回答涉及历史工作、任务成果或文件内容时，指出对应产物（标题 + ID），让用户能直接在产物库打开核对，不要等用户追问出处。',
  '4. 摘要不等于事实：宁可多读一次原文，也不要把摘要当结论。',
  '5. 用户询问任务进展/进度/执行到哪了时，调用 get_task 并转述 progress（第几步/共几步、正在执行的工具、已耗时、token 消耗占预算），不要编造未在 progress 里的细节。',
  '## 对话约定',
  '- 用中文；先给结论，再给必要细节；简洁但有信息量。',
  '- 需要动手就派任务，不空谈；任务创建后告诉用户任务 ID，并说明可在任务页看实时进度。',
  '- 需要用户做选择时，用 A. B. C. … 的格式每行一项列出，用户会点选。',
  '- 子智能体失败时如实汇报原因，并给出建议（重试、取消或调整目标重派）。',
  '- 不向用户索要敏感信息；对话与任务记录都会保存在本地数据库。',
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
  /**
   * 本轮系统提示词；缺省取设置 mainSystemPrompt，再缺省用内置 MAIN_SYSTEM_PROMPT。
   * 调用方显式传入时优先，便于特殊轮次覆盖（M10-05）。
   */
  systemPrompt?: string;
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
  /**
   * 思考链增量转发（M13-02）。与 onTextDelta 一样仅在流式路径生效；
   * 缺省时思考链只随 done.response.reasoningContent 返回，不逐帧转发。
   */
  onReasoningDelta?: (text: string) => void;
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
 * 把 text_delta / reasoning_delta 转发给调用方，并等 done 事件返回完整响应。
 *
 * 注意：不能在 stream 失败时静默退回 chat——那会让同一个用户请求可能被
 * 计费两次，也会掩盖真实的网络/鉴权错误。这里只按“是否要求流式”二选一。
 */
async function requestProviderResponse(
  provider: LlmProvider,
  params: ChatParams,
  onTextDelta: ((text: string) => void) | undefined,
  onReasoningDelta: ((text: string) => void) | undefined,
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
    if (event.type === 'reasoning_delta') {
      if (event.text.length > 0 && onReasoningDelta !== undefined) {
        onReasoningDelta(event.text);
      }
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
  const settings = getSettings(db);
  const roleSettings = settings.main;
  const model = options.model ?? roleSettings.model;
  const reasoningEffort =
    options.reasoningEffort ??
    (roleSettings.thinkingLevel === 'off' ? undefined : roleSettings.thinkingLevel);
  const temperature = options.temperature ?? roleSettings.temperature;
  const topP = options.topP ?? roleSettings.topP;
  const maxTokens = options.maxTokens ?? roleSettings.maxTokens;
  const maxToolRounds = normalizeMaxToolRounds(options.maxToolRounds);
  const historyTurns = normalizeHistoryTurns(options.historyLimit);
  // 提示词同样每轮读取：设置里自定义后下一轮立即生效；显式入参仍优先。
  const systemPrompt = options.systemPrompt ?? settings.mainSystemPrompt ?? MAIN_SYSTEM_PROMPT;

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

  // 滚动摘要（M12-02）：在写本轮 user 之前 fire-and-forget，既不阻塞本轮，
  // 也不会把刚写入的半轮算进摘要。失败必须留 WARN，并让本轮继续使用旧的
  // 「[已省略 N 轮更早对话]」标记（不静默吞掉）。
  void maybeCompactSummary(db, provider, { now: clock }).catch((error: unknown) => {
    console.warn(
      '[summary] 滚动摘要生成失败，本轮回退省略标记:',
      error instanceof Error ? error.message : String(error),
    );
  });

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
    systemPrompt,
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
  /** 每轮思考链各一段（M13-02）；最终以空行连接后随回复落库。 */
  const reasoningRounds: string[] = [];
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
    // 流式路径逐帧收集本轮思考链；非流式路径退回 done/chat 响应里的全量字段。
    let roundReasoningViaDelta = '';
    const onReasoningDelta =
      options.onReasoningDelta === undefined
        ? undefined
        : (text: string): void => {
            roundReasoningViaDelta += text;
            options.onReasoningDelta!(text);
          };
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
      response = await requestProviderResponse(
        provider,
        params,
        options.onTextDelta,
        onReasoningDelta,
      );
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

    const roundReasoning =
      roundReasoningViaDelta.length > 0
        ? roundReasoningViaDelta
        : (response.reasoningContent ?? '');
    if (roundReasoning.length > 0) reasoningRounds.push(roundReasoning);

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
  const reasoning = reasoningRounds.join('\n\n');
  appendMessage(db, {
    role: 'assistant',
    content: reply,
    tokens: usage.outputTokens,
    ...(reasoning.length > 0 ? { reasoning } : {}),
    ts: clock(),
  });

  return { reply, toolTrace, usage: snapshotUsage(usage) };
}
