/**
 * 契约层 · 类型定义（SPEC §4.2 / §4.3 / §4.4）
 * 硬约束：零依赖、零 IO；只用可擦除语法（无 enum / namespace）。
 */

/** 可作为事件 payload 的 lossless JSON 值。 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

// ── 任务状态（SPEC §4.3）─────────────────────────────────────────
export const TASK_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
  'waiting_input',
  'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

// ── 运行状态（SPEC §4.2 runs.status）─────────────────────────────
export const RUN_STATUSES = [
  'running',
  'completed',
  'failed',
  'interrupted',
  'cancelled',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

// ── 事件类型（SPEC §4.4，共 15 种）───────────────────────────────
export const EVENT_TYPES = [
  'task.created',
  'task.queued',
  'task.started',
  'agent.step',
  'llm.call',
  'agent.message',
  'agent.tool_call',
  'agent.tool_result',
  'artifact.created',
  'summary.generated',
  'budget.warning',
  'task.completed',
  'task.failed',
  'task.cancelled',
  'memory.fact_upserted',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_ACTORS = ['user', 'main', 'agent', 'system'] as const;
export type EventActor = (typeof EVENT_ACTORS)[number];

export const PERMISSION_MODES = ['read-only', 'workspace-write'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** 任务失败原因（写入 task.failed 事件与 tasks.result_json）。 */
export const TASK_FAILED_REASONS = [
  'max_steps',
  'max_tokens',
  'wall_clock',
  'tool_args_invalid',
  'result_invalid',
  'interrupted',
  'exception',
] as const;
export type TaskFailedReason = (typeof TASK_FAILED_REASONS)[number];

// ── 数据模型（列名 → camelCase）───────────────────────────────────
export interface Task {
  id: string;
  parentId: string | null;
  title: string;
  goal: string;
  status: TaskStatus;
  revision: number;
  permission: PermissionMode;
  workspace: string;
  budgetTokens: number;
  spentTokens: number;
  resultJson: string | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

export interface TaskRun {
  id: string;
  taskId: string;
  attempt: number;
  status: RunStatus;
  leaseUntil: number;
  steps: number;
  error: string | null;
  startedAt: number;
  endedAt: number | null;
}

export interface TaskEvent {
  /** 全局单调自增序号；SSE 断点续传依赖它。 */
  seq: number;
  taskId: string | null;
  runId: string | null;
  ts: number;
  type: EventType;
  actor: EventActor;
  payload: JsonValue;
}

// ── 模型层 ───────────────────────────────────────────────────────
export interface TokenUsage {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  /** usage 缺失时按估算记账（SPEC §4.8）。 */
  estimated: boolean;
}

export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LlmToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    /** 模型返回的 JSON 字符串；拼完才允许 parse（SPEC 附录 A）。 */
    arguments: string;
  };
}

/** 多模态内容分片（v1.1）：文本或图片（data URL 或 https）。 */
export type LlmContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface LlmMessage {
  role: LlmRole;
  /** 纯文本，或多模态分片数组（v1.1 起；历史消息建议仅当前轮携带图片以控成本）。 */
  content: string | readonly LlmContentPart[];
  toolCallId?: string;
  toolCalls?: LlmToolCall[];
}

/** 提取 content 的纯文本（多模态分片取 text 部分，图片折为占位）。 */
export function llmContentText(content: LlmMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((part) => (part.type === 'text' ? part.text : '[图片]'))
    .join('');
}

export interface LlmResponse {
  content: string | null;
  toolCalls: LlmToolCall[];
  usage?: TokenUsage;
  finishReason: string;
  /** 思考链全文（M13-02）：reasoning 模型返回；仅用于展示/落库，禁止回喂给 API。 */
  reasoningContent?: string;
}

/** 工具声明（注册表用；parameters 为 JSON Schema，契约层不解析）。 */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: unknown;
}
