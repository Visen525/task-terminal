/**
 * 主对话滚动摘要（SPEC §10 M12-02）。
 *
 * 12 轮窗口之外、尚未摘要的完整轮次（user + assistant 成对）会被压缩进
 * settings.mainConversationSummary：旧摘要 + 新省略轮 → 模型输出 ≤2000 字
 * 的中文条目化摘要。upToSeq 记录已并入摘要的最后一条 assistant 消息 seq，
 * 因此下一轮只处理它之后的消息，不会重复摘要同一轮。
 *
 * 边界：
 *   - 只读/写主线 messages（task_id IS NULL）与 settings，不写事件；
 *   - 摘要生成失败不吞：provider/空输出异常向上抛，调用方负责 WARN 并回退
 *     到旧的「[已省略 N 轮更早对话]」标记；
 *   - 同一时刻只允许一个压缩任务（模块级 promise 串行），并发调用直接复用
 *     正在进行的 promise，避免同一段历史被两个模型调用重复计费。
 */
import type { DatabaseSync } from 'node:sqlite';

import { ContractError, ERROR_CODES } from '../core/errors.ts';
import type { LlmResponse } from '../core/types.ts';
import {
  estimateTokenUsage,
  type ChatParams,
  type LlmProvider,
} from '../providers/types.ts';
import {
  insertLlmCall,
  type LlmCallPurpose,
} from '../store/llm-calls.ts';
import {
  getSettings,
  saveSettings,
  type MainConversationSummary,
} from '../store/settings.ts';

/** 摘要窗口：最近 12 轮保持全文，超出的完整轮才可省略。 */
export const SUMMARY_WINDOW_TURNS = 12;
/** 摘要正文硬上限（Unicode 码点）。 */
export const SUMMARY_MAX_CHARS = 2000;

export interface MaybeCompactSummaryOptions {
  /** 可注入时钟（毫秒时间戳）；默认 Date.now。 */
  now?: () => number;
}

interface SummaryMessageRow {
  seq: number;
  role: string;
  content: string;
}

interface DialogueTurn {
  userSeq: number;
  assistantSeq: number;
  userText: string;
  assistantText: string;
}

const SUMMARY_SYSTEM_PROMPT = [
  '你是任务台主对话的滚动摘要器。请把「已有摘要」与「新增对话」合并压缩成新的中文摘要。',
  '硬性要求：',
  '1. 只输出摘要正文，不要解释、不要代码块、不要“好的”等客套。',
  '2. 总长度不超过 2000 个字符。',
  '3. 必须条目化，每条以“- ”开头。',
  '4. 保留：用户偏好/习惯、关键结论、任务派发记录（标题与状态）、未决事项。',
  '5. 不编造对话中没有的信息；不确定的写“未确认”。',
].join('\n');

/** 解析 messages.content（与 store/messages 的 JSON 格式保持一致）。 */
function parseStoredText(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ContractError(
      ERROR_CODES.E_INTERNAL,
      `messages.content 不是合法 JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (typeof parsed === 'string') return parsed;
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    typeof (parsed as { text?: unknown }).text === 'string'
  ) {
    return (parsed as { text: string }).text;
  }
  throw new ContractError(ERROR_CODES.E_INTERNAL, 'messages.content 格式不合法');
}

/**
 * 读取 upToSeq 之后的完整轮次；落单的 user（例如本轮刚写入、assistant 尚未
 * 回复）不构成完整轮，直接忽略，保证摘要永远是 user+assistant 成对。
 */
function readCompleteTurns(db: DatabaseSync, afterSeq: number): DialogueTurn[] {
  const rows = db
    .prepare(
      `SELECT seq, role, content FROM messages
        WHERE task_id IS NULL AND seq > ? AND role IN ('user', 'assistant')
        ORDER BY seq ASC`,
    )
    .all(afterSeq) as unknown as SummaryMessageRow[];

  const turns: DialogueTurn[] = [];
  let pendingUser: { seq: number; text: string } | null = null;
  for (const row of rows) {
    if (row.role === 'user') {
      pendingUser = { seq: row.seq, text: parseStoredText(row.content) };
      continue;
    }
    if (row.role === 'assistant' && pendingUser !== null) {
      turns.push({
        userSeq: pendingUser.seq,
        assistantSeq: row.seq,
        userText: pendingUser.text,
        assistantText: parseStoredText(row.content),
      });
      pendingUser = null;
    }
  }
  return turns;
}

/** 全局轮号：主线按 user+assistant 成对落库，user seq 1/3/5… 对应第 1/2/3… 轮。 */
function turnNumber(userSeq: number): number {
  return Math.floor(userSeq / 2) + 1;
}

function formatDialogue(turns: readonly DialogueTurn[]): string {
  return turns
    .map((turn) => {
      const number = turnNumber(turn.userSeq);
      return [
        `### 第 ${number} 轮`,
        `用户：${turn.userText}`,
        `助手：${turn.assistantText}`,
      ].join('\n');
    })
    .join('\n\n');
}

function buildSummaryPrompt(
  previous: MainConversationSummary | null,
  omitted: readonly DialogueTurn[],
): ChatParams['messages'] {
  const first = omitted[0]!;
  const last = omitted[omitted.length - 1]!;
  const parts: string[] = [];
  if (previous !== null) {
    parts.push(`## 已有摘要（截至第 ${Math.floor(previous.upToSeq / 2)} 轮）\n${previous.text}`);
  }
  parts.push(
    `## 新增省略轮（第 ${turnNumber(first.userSeq)}–${turnNumber(last.userSeq)} 轮）\n${formatDialogue(omitted)}`,
  );
  return [
    { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

function truncateSummary(text: string): string {
  return [...text].slice(0, SUMMARY_MAX_CHARS).join('');
}

function recordSummaryCall(
  db: DatabaseSync,
  model: string,
  measured: { inputTokens: number; cachedTokens: number; outputTokens: number; estimated?: boolean },
  latencyMs: number,
  ts: number,
): void {
  insertLlmCall(db, {
    taskId: null,
    runId: null,
    // llm_calls.purpose 列在 DDL 里是自由文本（无 CHECK）；store 层的
    // LlmCallPurpose 联合类型属于本卡禁改范围，这里显式收窄写入 'summary'。
    purpose: 'summary' as unknown as LlmCallPurpose,
    model,
    inputTokens: measured.inputTokens,
    cachedTokens: measured.cachedTokens,
    outputTokens: measured.outputTokens,
    latencyMs,
    estimated: measured.estimated === true,
    ts,
  });
}

async function compact(
  db: DatabaseSync,
  provider: LlmProvider,
  clock: () => number,
): Promise<MainConversationSummary | null> {
  const settings = getSettings(db);
  const previous = settings.mainConversationSummary;
  const upToSeq = previous?.upToSeq ?? 0;

  const turns = readCompleteTurns(db, upToSeq);
  if (turns.length <= SUMMARY_WINDOW_TURNS) return null;

  const omitted = turns.slice(0, turns.length - SUMMARY_WINDOW_TURNS);
  const lastOmitted = omitted[omitted.length - 1]!;
  const params: ChatParams = {
    messages: buildSummaryPrompt(previous, omitted),
    model: settings.main.model,
    temperature: settings.main.temperature,
    topP: settings.main.topP,
    maxTokens: settings.main.maxTokens,
    ...(settings.main.thinkingLevel === 'off'
      ? {}
      : { reasoningEffort: settings.main.thinkingLevel }),
  };

  const startedAt = Date.now();
  let response: LlmResponse;
  try {
    response = await provider.chat(params);
  } catch (error) {
    // 失败也记账（usage 未知记 0），再原样抛给调用方做 WARN + 回退。
    recordSummaryCall(
      db,
      settings.main.model,
      { inputTokens: 0, cachedTokens: 0, outputTokens: 0 },
      Math.max(0, Date.now() - startedAt),
      clock(),
    );
    throw error;
  }

  const measured =
    response.usage ?? estimateTokenUsage(params.messages, response.content, response.toolCalls);
  recordSummaryCall(
    db,
    settings.main.model,
    measured,
    Math.max(0, Date.now() - startedAt),
    clock(),
  );

  const text = truncateSummary((response.content ?? '').trim());
  if (text.length === 0) {
    throw new ContractError(ERROR_CODES.E_INTERNAL, '摘要模型返回空内容');
  }

  const updatedAt = clock();
  const summary: MainConversationSummary = {
    text,
    upToSeq: lastOmitted.assistantSeq,
    updatedAt,
  };
  saveSettings(db, { mainConversationSummary: summary }, updatedAt);
  return summary;
}

/** 模块级单飞：任意时刻最多一个压缩任务，后来的调用复用同一个 promise。 */
let activeCompaction: Promise<MainConversationSummary | null> | null = null;

/**
 * 尝试把超出 12 轮窗口的完整轮次并入滚动摘要。
 *
 * - 不足/恰好 12 轮，或没有完整可省略轮 → 返回 null，不调用模型；
 * - 成功 → 更新 settings.mainConversationSummary 并返回它；
 * - 失败 → 记录调用后抛错（调用方必须 WARN 并回退省略标记）。
 * - 已有压缩在跑 → 直接返回其 promise，不并发再开一次。
 */
export function maybeCompactSummary(
  db: DatabaseSync,
  provider: LlmProvider,
  options: MaybeCompactSummaryOptions = {},
): Promise<MainConversationSummary | null> {
  if (activeCompaction !== null) return activeCompaction;

  const clock = options.now ?? Date.now;
  const running = compact(db, provider, clock);
  activeCompaction = running;
  running.then(
    () => {
      if (activeCompaction === running) activeCompaction = null;
    },
    () => {
      if (activeCompaction === running) activeCompaction = null;
    },
  );
  return running;
}

/**
 * 上下文里的摘要块。N 是已摘要的轮数（upToSeq 是轮末 assistant 的 seq）。
 */
export function formatSummaryBlock(summary: MainConversationSummary): string {
  const turns = Math.max(0, Math.floor(summary.upToSeq / 2));
  return `## 对话记忆（早期摘要，截至第 ${turns} 轮）\n${summary.text}`;
}
