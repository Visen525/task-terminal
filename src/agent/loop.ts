/**
 * 执行内核 · 子智能体执行循环（SPEC §4.5 / §7 M3-03）
 *
 * 一次循环（step）= 一次完整的模型流式调用 + 该轮全部工具调用的分发。
 * 五条不变量在本文件的落点：
 *   1. 每步先写 agent.step，再写 llm.call；工具调用与结果由 executeTool 成对写入，
 *      submit_result / ask_user 这两个控制流工具由 loop 自己成对写入。
 *   2. 所有失败路径（上限、异常、结果非法）都写 task.failed{reason} 后返回，不抛出。
 *   3. 一切副作用只经 executeTool(name, args, ctx) 执行；本文件不 import 任何 IO 模块。
 *   4. 步数 / token / 墙钟三重上限，任一触发即终止。
 *   5. 只有通过 result schema 校验的 submit_result 才算 completed。
 *
 * tool_call 只在 done 事件之后才被解析和执行；done 之前的 tool_call_delta 一律忽略。
 */
import type { DatabaseSync } from 'node:sqlite';

import { ContractError, ERROR_CODES } from '../core/errors.ts';
import type {
  JsonValue,
  LlmMessage,
  LlmResponse,
  PermissionMode,
  TaskFailedReason,
  TokenUsage,
  ToolSpec,
} from '../core/types.ts';
import {
  estimateTokenUsage,
  isAbortError,
  type ChatParams,
  type LlmProvider,
  type LlmStreamEvent,
} from '../providers/types.ts';
import { appendEvent } from '../store/events.ts';
import {
  TOOL_SPECS,
  createToolContext,
  executeTool,
  type CreateToolContextOptions,
  type ToolResult,
} from './executeTool.ts';
import { buildAgentPrompt } from './prompt.ts';
import {
  SUBMIT_RESULT_SPEC,
  toResultJsonValue,
  validateSubmitResult,
  type SubmitResult,
} from './result-validator.ts';

// ── 公共类型 ─────────────────────────────────────────────────────

/** 三重上限默认值（SPEC §4.8）；M3-04 的 watchdog 会复用同一组语义。 */
export const DEFAULT_LOOP_LIMITS = {
  maxSteps: 30,
  maxTokens: 120_000,
  wallMs: 20 * 60 * 1000,
  model: 'deepseek-chat',
} as const;

export interface LoopLimits {
  maxSteps: number;
  maxTokens: number;
  wallMs: number;
  model: string;
}

export interface LoopTask {
  id: string;
  title?: string;
  goal: string;
  permission: PermissionMode;
  workspace: string;
}

/** 透传给 createToolContext 的可注入项（outputDir / allowedCommands 等）。 */
export type LoopToolContextOptions = Pick<
  CreateToolContextOptions,
  'outputDir' | 'allowedCommands' | 'timeoutMs' | 'maxOutputBytes' | 'env'
>;

export interface RunLoopOptions {
  task: LoopTask;
  db: DatabaseSync;
  provider: LlmProvider;
  /** 可注入上限；未提供的项取 DEFAULT_LOOP_LIMITS。 */
  limits?: Partial<LoopLimits>;
  signal?: AbortSignal;
  /** 透传给工具上下文；workspace/db/taskId/permission/signal 由 loop 控制。 */
  ctx?: LoopToolContextOptions;
  runId?: string | null;
  /** 写入 task.failed 事件的 attempt；默认 1。 */
  attempt?: number;
}

export interface LoopUsage {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  /** input + output（cached 是 input 的子集，不重复计入）。 */
  totalTokens: number;
}

export interface LoopStats {
  steps: number;
  usage: LoopUsage;
  elapsedMs: number;
}

export interface LoopError {
  code: string;
  message: string;
}

export interface LoopCompleted extends LoopStats {
  status: 'completed';
  result: SubmitResult;
  /** 与 task.completed.result_json 一致的 JSON 文本。 */
  resultJson: string;
}

export interface LoopFailed extends LoopStats {
  status: 'failed';
  reason: TaskFailedReason;
  error?: LoopError;
}

export interface LoopWaiting extends LoopStats {
  status: 'waiting_input';
  question: string;
}

export type LoopOutcome = LoopCompleted | LoopFailed | LoopWaiting;

/** ask_user 是子智能体的控制流工具，不是文件/命令工具。 */
export const ASK_USER_SPEC: ToolSpec = {
  name: 'ask_user',
  description: '停下来向用户提一个必须由人回答的问题，任务随后进入 waiting_input。',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', minLength: 1, description: '要问用户的问题' },
    },
    required: ['question'],
    additionalProperties: false,
  },
};

/** 子智能体可用的全部工具：六件套 + ask_user + submit_result。 */
export const AGENT_TOOL_SPECS: ToolSpec[] = [...TOOL_SPECS, ASK_USER_SPEC, SUBMIT_RESULT_SPEC];

// ── 小工具 ───────────────────────────────────────────────────────

const MAX_PREVIEW_CHARS = 500;

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 1)}…`;
}

function previewOf(value: unknown): string {
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return clip(text ?? '', MAX_PREVIEW_CHARS);
  } catch {
    return '[unserializable args]';
  }
}

function nonNegativeInteger(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function normalizeLimits(partial: Partial<LoopLimits> | undefined): LoopLimits {
  const maxStepsInput = partial?.maxSteps;
  const maxTokensInput = partial?.maxTokens;
  const wallMsInput = partial?.wallMs;
  const modelInput = partial?.model;

  return {
    maxSteps:
      typeof maxStepsInput === 'number' &&
      Number.isFinite(maxStepsInput) &&
      maxStepsInput >= 0
        ? Math.floor(maxStepsInput)
        : DEFAULT_LOOP_LIMITS.maxSteps,
    maxTokens:
      typeof maxTokensInput === 'number' &&
      Number.isFinite(maxTokensInput) &&
      maxTokensInput >= 0
        ? Math.floor(maxTokensInput)
        : DEFAULT_LOOP_LIMITS.maxTokens,
    wallMs:
      typeof wallMsInput === 'number' && Number.isFinite(wallMsInput) && wallMsInput > 0
        ? Math.floor(wallMsInput)
        : DEFAULT_LOOP_LIMITS.wallMs,
    model:
      typeof modelInput === 'string' && modelInput.trim().length > 0
        ? modelInput
        : DEFAULT_LOOP_LIMITS.model,
  };
}

function toLoopError(error: unknown): LoopError {
  if (error instanceof ContractError) {
    return { code: error.code, message: error.message };
  }
  // 未知异常不回显原始 message，避免把路径/key 带进事件或返回值。
  return { code: ERROR_CODES.E_INTERNAL, message: '循环执行异常（未分类错误）' };
}

function addUsage(target: LoopUsage, usage: TokenUsage): void {
  target.inputTokens += nonNegativeInteger(usage.inputTokens);
  target.cachedTokens += nonNegativeInteger(usage.cachedTokens);
  target.outputTokens += nonNegativeInteger(usage.outputTokens);
}

function snapshotUsage(usage: LoopUsage): LoopUsage {
  return {
    inputTokens: usage.inputTokens,
    cachedTokens: usage.cachedTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.inputTokens + usage.outputTokens,
  };
}

function formatToolResultForModel(result: ToolResult): string {
  if (result.ok) {
    return result.output.length > 0 ? result.output : '(工具执行成功，无输出)';
  }
  const code = result.code ?? 'E_TOOL_FAILED';
  const message = result.error?.message ?? result.preview;
  const body = result.output.length > 0 && result.output !== message ? `\n${result.output}` : '';
  return `[工具失败] ${code}: ${message}${body}`;
}

function formatSubmitErrors(errors: string[], attempt: number): string {
  return [
    `submit_result 校验失败（第 ${attempt} 次提交），请修正后重新调用 submit_result；只允许再重试一次：`,
    ...errors.map((error, index) => `${index + 1}. ${error}`),
  ].join('\n');
}

function parseToolArguments(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const text = raw.trim();
  if (text.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: '参数不是合法 JSON，请检查引号、逗号与括号' };
  }
}

function extractQuestion(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const question = (value as Record<string, unknown>).question;
  if (typeof question !== 'string' || question.trim().length === 0) return null;
  return question;
}

/** 只取 done 事件；增量事件只是分片，绝不在此解析或执行。 */
async function collectStream(
  provider: LlmProvider,
  params: ChatParams,
): Promise<LlmResponse> {
  let response: LlmResponse | null = null;
  for await (const event of provider.stream(params) as AsyncIterable<LlmStreamEvent>) {
    if (event.type === 'done') {
      if (response !== null) {
        throw new ContractError(ERROR_CODES.E_INTERNAL, 'provider stream 返回了多个 done 事件');
      }
      response = event.response;
    }
  }
  if (response === null) {
    throw new ContractError(ERROR_CODES.E_INTERNAL, 'provider stream 未返回 done 事件');
  }
  return response;
}

// ── 主循环 ───────────────────────────────────────────────────────

export async function runLoop(options: RunLoopOptions): Promise<LoopOutcome> {
  const task = options.task;
  const limits = normalizeLimits(options.limits);
  const startedAt = Date.now();
  const externalSignal = options.signal;

  let steps = 0;
  let submitAttempts = 0;
  let wallExpired = false;
  const usage: LoopUsage = {
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };

  const controller = new AbortController();
  const externallyAborted = (): boolean => externalSignal?.aborted === true;
  const forwardAbort = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(externalSignal?.reason);
    }
  };
  if (externalSignal !== undefined) {
    if (externalSignal.aborted) forwardAbort();
    else externalSignal.addEventListener('abort', forwardAbort, { once: true });
  }
  const wallTimer = setTimeout(() => {
    wallExpired = true;
    if (!controller.signal.aborted) {
      controller.abort(new Error('wall clock exceeded'));
    }
  }, limits.wallMs);
  wallTimer.unref();

  const stats = (): LoopStats => ({
    steps,
    usage: snapshotUsage(usage),
    elapsedMs: Math.max(0, Date.now() - startedAt),
  });

  const appendTaskEvent = (
    type: 'task.completed' | 'task.failed',
    payload: JsonValue,
  ): void => {
    appendEvent(options.db, {
      taskId: task.id,
      runId: options.runId ?? null,
      type,
      actor: 'system',
      payload,
    });
  };

  const fail = (reason: TaskFailedReason, error?: LoopError): LoopFailed => {
    appendTaskEvent('task.failed', {
      reason,
      attempt: options.attempt ?? 1,
      ...(error === undefined ? {} : { error_code: error.code }),
    });
    return {
      status: 'failed',
      reason,
      ...(error === undefined ? {} : { error }),
      ...stats(),
    };
  };

  const complete = (value: SubmitResult): LoopCompleted => {
    const resultJson = JSON.stringify(value);
    appendTaskEvent('task.completed', { result_json: toResultJsonValue(value) });
    return { status: 'completed', result: value, resultJson, ...stats() };
  };

  const appendLlmCall = (measured: TokenUsage, ms: number): void => {
    appendEvent(options.db, {
      taskId: task.id,
      runId: options.runId ?? null,
      type: 'llm.call',
      actor: 'system',
      payload: {
        model: limits.model,
        in: nonNegativeInteger(measured.inputTokens),
        cached: nonNegativeInteger(measured.cachedTokens),
        out: nonNegativeInteger(measured.outputTokens),
        ms,
      },
    });
  };

  const appendControlToolCall = (tool: string, args: unknown, extra?: JsonValue): void => {
    appendEvent(options.db, {
      taskId: task.id,
      runId: options.runId ?? null,
      type: 'agent.tool_call',
      actor: 'agent',
      payload: {
        tool,
        args_preview: previewOf(args),
        ...(typeof extra === 'object' && extra !== null && !Array.isArray(extra) ? extra : {}),
      },
    });
  };

  const appendControlToolResult = (
    ok: boolean,
    preview: string,
    code?: string,
  ): void => {
    appendEvent(options.db, {
      taskId: task.id,
      runId: options.runId ?? null,
      type: 'agent.tool_result',
      actor: 'system',
      payload: {
        ok,
        preview: clip(preview, MAX_PREVIEW_CHARS),
        ms: 0,
        ...(code === undefined ? {} : { code }),
      },
    });
  };

  const messages: LlmMessage[] = [
    { role: 'system', content: buildAgentPrompt(task, task.permission) },
    {
      role: 'user',
      content: '现在开始执行任务。请按系统提示中的规则操作，结束时必须调用 submit_result。',
    },
  ];
  const tools = AGENT_TOOL_SPECS;

  const appendToolMessage = (toolCallId: string, content: string): void => {
    messages.push({ role: 'tool', toolCallId, content });
  };

  try {
    const ctx = createToolContext({
      ...options.ctx,
      workspace: task.workspace,
      db: options.db,
      taskId: task.id,
      runId: options.runId ?? null,
      permission: task.permission,
      signal: controller.signal,
    });

    for (;;) {
      if (wallExpired || Date.now() - startedAt >= limits.wallMs) {
        return fail('wall_clock');
      }
      if (externallyAborted()) {
        return fail('interrupted');
      }
      if (steps >= limits.maxSteps) {
        return fail('max_steps');
      }
      if (usage.inputTokens + usage.outputTokens >= limits.maxTokens) {
        return fail('max_tokens');
      }

      steps += 1;
      appendEvent(options.db, {
        taskId: task.id,
        runId: options.runId ?? null,
        type: 'agent.step',
        actor: 'agent',
        payload: { step_no: steps },
      });

      const callStartedAt = Date.now();
      let response: LlmResponse;
      try {
        response = await collectStream(options.provider, {
          // 传快照：provider 可能在调用后才被消费，调用记录不应随后续轮次变化。
          messages: [...messages],
          tools,
          model: limits.model,
          signal: controller.signal,
          toolChoice: 'auto',
        });
      } catch (error) {
        // 失败的调用也记一条 llm.call（usage 未知记 0），保证每个 step 都有调用留痕。
        appendLlmCall(
          { inputTokens: 0, cachedTokens: 0, outputTokens: 0, estimated: false },
          Math.max(0, Date.now() - callStartedAt),
        );
        if (wallExpired) return fail('wall_clock');
        if (externallyAborted() || isAbortError(error)) return fail('interrupted');
        return fail('exception', toLoopError(error));
      }

      const measured =
        response.usage ??
        estimateTokenUsage(messages, response.content, response.toolCalls);
      addUsage(usage, measured);
      appendLlmCall(measured, Math.max(0, Date.now() - callStartedAt));

      if (wallExpired || Date.now() - startedAt >= limits.wallMs) {
        return fail('wall_clock');
      }
      if (usage.inputTokens + usage.outputTokens >= limits.maxTokens) {
        return fail('max_tokens');
      }
      if (externallyAborted()) {
        return fail('interrupted');
      }

      const text = response.content ?? '';
      if (text.length > 0) {
        appendEvent(options.db, {
          taskId: task.id,
          runId: options.runId ?? null,
          type: 'agent.message',
          actor: 'agent',
          payload: { text },
        });
      }

      if (response.toolCalls.length === 0) {
        messages.push({ role: 'assistant', content: text });
        continue;
      }

      messages.push({ role: 'assistant', content: text, toolCalls: response.toolCalls });

      for (const call of response.toolCalls) {
        if (wallExpired || Date.now() - startedAt >= limits.wallMs) {
          return fail('wall_clock');
        }
        if (externallyAborted()) {
          return fail('interrupted');
        }

        const toolName = call.function.name;
        const parsed = parseToolArguments(call.function.arguments);

        // ── 控制流：submit_result（无副作用，不经 executeTool）──────────
        if (toolName === 'submit_result') {
          submitAttempts += 1;
          if (!parsed.ok) {
            const errors = [`submit_result ${parsed.error}`];
            appendControlToolCall('submit_result', call.function.arguments);
            appendControlToolResult(false, errors.join('；'), ERROR_CODES.E_RESULT_INVALID);
            if (submitAttempts >= 2) {
              return fail('result_invalid', {
                code: ERROR_CODES.E_RESULT_INVALID,
                message: 'submit_result 连续两次未通过校验',
              });
            }
            appendToolMessage(call.id, formatSubmitErrors(errors, submitAttempts));
            continue;
          }

          const validation = validateSubmitResult(parsed.value);
          if (validation.ok) {
            appendControlToolCall('submit_result', parsed.value);
            appendControlToolResult(true, 'submit_result 校验通过，任务完成');
            return complete(validation.value);
          }

          appendControlToolCall('submit_result', parsed.value);
          appendControlToolResult(false, validation.errors.join('；'), ERROR_CODES.E_RESULT_INVALID);
          if (submitAttempts >= 2) {
            return fail('result_invalid', {
              code: ERROR_CODES.E_RESULT_INVALID,
              message: 'submit_result 连续两次未通过校验',
            });
          }
          appendToolMessage(call.id, formatSubmitErrors(validation.errors, submitAttempts));
          continue;
        }

        // ── 控制流：ask_user（无副作用；写一条 tool_call 让 foldEvents 折出 waiting_input）──
        if (toolName === 'ask_user') {
          if (!parsed.ok) {
            // 不写 tool_call：任何 ask_user 的 tool_call 都会让 foldEvents 进入
            // waiting_input，而参数非法的请求不应该改变任务状态。
            appendToolMessage(call.id, `ask_user ${parsed.error}`);
            continue;
          }
          const question = extractQuestion(parsed.value);
          if (question === null) {
            appendToolMessage(call.id, 'ask_user 参数非法：question 必须是非空字符串');
            continue;
          }
          appendControlToolCall('ask_user', parsed.value, { question });
          return { status: 'waiting_input', question, ...stats() };
        }

        // ── 普通工具：参数非法时补一对失败事件并回喂，不执行任何东西 ──
        if (!parsed.ok) {
          appendControlToolCall(toolName, call.function.arguments);
          appendControlToolResult(
            false,
            `${toolName} ${parsed.error}`,
            ERROR_CODES.E_INVALID_ARGUMENT,
          );
          appendToolMessage(call.id, `[工具参数错误] ${toolName}: ${parsed.error}`);
          continue;
        }

        // ── 唯一副作用出口 ─────────────────────────────────────────
        try {
          const result = await executeTool(toolName, parsed.value, ctx);
          appendToolMessage(call.id, formatToolResultForModel(result));
        } catch (error) {
          if (wallExpired) return fail('wall_clock');
          if (externallyAborted()) return fail('interrupted');
          // 工具失败（ContractError）= 工具失败，不是循环失败；回喂给模型调整。
          const loopError = toLoopError(error);
          appendToolMessage(
            call.id,
            `[工具失败] ${loopError.code}: ${loopError.message}`,
          );
        }

        if (wallExpired || Date.now() - startedAt >= limits.wallMs) {
          return fail('wall_clock');
        }
      }
    }
  } catch (error) {
    if (wallExpired) return fail('wall_clock');
    if (externallyAborted()) return fail('interrupted');
    return fail('exception', toLoopError(error));
  } finally {
    clearTimeout(wallTimer);
    externalSignal?.removeEventListener('abort', forwardAbort);
  }
}
