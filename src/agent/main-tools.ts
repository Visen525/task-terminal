/**
 * 主线 AI 工具集（SPEC §4.6 / §7 M5-01）。
 *
 * 十件套只做「查库 / 调 ops / 调长期事实仓储 / 调产物仓储」：
 *   - 主线需要实际动手时只能 create_task，本文件不读写文件、不执行命令；
 *   - create_task / retry_task 成功后调用注入的 onTaskCreated，由装配层接
 *     scheduler.tick；
 *   - 工具失败以结构化结果返回给模型，不抛出未分类异常（由 main-loop 回喂）。
 */
import type { DatabaseSync } from 'node:sqlite';

import { ContractError, ERROR_CODES } from '../core/errors.ts';
import {
  TASK_STATUSES,
  type PermissionMode,
  type Task,
  type TaskStatus,
  type ToolSpec,
} from '../core/types.ts';
import {
  cancelTask,
  createTask,
  retryTask,
  type TaskCanceller,
} from '../runtime/ops.ts';
import { getArtifact, type Artifact } from '../store/artifacts.ts';
import { appendEvent, listEvents, type ListEventsOptions } from '../store/events.ts';
import { recallFacts, upsertFact, type Fact } from '../store/facts.ts';
import { getTask, listTasks } from '../store/repo.ts';
import { searchArtifactsRanked } from '../store/search.ts';
import { readArtifactNoteContent } from './artifacts.ts';

/** read_artifact 默认分页大小；M7-01 落正文前返回空串。 */
export const DEFAULT_ARTIFACT_PAGE_CHARS = 2000;
/** read_artifact 单页硬上限，防止模型一次拉爆上下文。 */
export const MAX_ARTIFACT_PAGE_CHARS = 20_000;
const RECENT_EVENT_LIMIT = 5;
const EVENT_PAGE_SIZE = 500;
const DEFAULT_TASK_LIMIT = 100;
const DEFAULT_ARTIFACT_SEARCH_LIMIT = 10;

export const MAIN_TOOL_SPECS: ToolSpec[] = [
  {
    name: 'list_tasks',
    description: '查看任务看板；可按状态过滤，默认按创建时间升序返回最多 100 条。',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: [...TASK_STATUSES], description: '任务状态' },
        limit: { type: 'integer', minimum: 1, description: '最多返回条数，默认 100' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'create_task',
    description:
      '派活：创建一个由子智能体执行的任务。需要读写文件、运行命令、分析数据时必须先调用它，主线自己不要执行。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, description: '任务标题' },
        goal: { type: 'string', minLength: 1, description: '交给执行体的完整目标' },
        permission: {
          type: 'string',
          enum: ['read-only', 'workspace-write'],
          description: '任务权限，默认 workspace-write',
        },
      },
      required: ['title', 'goal'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_task',
    description: '查看单个任务的状态，并附带最近 5 条事件摘要。',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', minLength: 1, description: '任务 ID（t_ 开头）' },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'cancel_task',
    description: '停止一个正在运行的任务；仅 running 任务可取消。',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', minLength: 1, description: '任务 ID' },
        reason: { type: 'string', minLength: 1, description: '取消原因，默认「主线取消」' },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'retry_task',
    description: '重试一个失败的任务；仅 failed 且尝试次数小于 3 时可重试。',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', minLength: 1, description: '任务 ID' },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_artifacts',
    description: '按关键词检索产物摘要（只返回摘要与片段，不返回正文）。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, description: '检索关键词' },
        limit: { type: 'integer', minimum: 1, description: '最多返回条数，默认 10' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_artifact',
    description:
      '读取产物正文，按字符分页；默认 offset=0、limit=2000。需要细节时先 search_artifacts 再调用。',
    parameters: {
      type: 'object',
      properties: {
        artifact_id: { type: 'string', minLength: 1, description: '产物 ID（a_ 开头）' },
        offset: { type: 'integer', minimum: 0, description: '起始字符偏移，默认 0' },
        limit: {
          type: 'integer',
          minimum: 1,
          description: '本页最多字符数，默认 2000，上限 20000',
        },
      },
      required: ['artifact_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'remember',
    description: '把一条长期事实写入记忆；同 scope + key 的新值会取代旧值。',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', minLength: 1, description: '事实键，例如 user.timezone' },
        value: { type: 'string', minLength: 1, description: '事实值' },
        scope: { type: 'string', minLength: 1, description: '作用域，默认 global' },
      },
      required: ['key', 'value'],
      additionalProperties: false,
    },
  },
  {
    name: 'recall',
    description: '按关键词检索当前有效的长期事实；query 为空时返回置信度最高的若干条。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词；可为空字符串' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'ask_user',
    description: '当用户意图不明确时直接向用户提问；本工具会立即结束本轮并返回问题。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', minLength: 1, description: '要问用户的问题' },
      },
      required: ['question'],
      additionalProperties: false,
    },
  },
];

/** 主线工具执行所需的装配项。 */
export interface MainToolOptions {
  db: DatabaseSync;
  /** create_task 的默认工作区；由装配层注入。 */
  workspace: string;
  /** create_task / retry_task 成功后的调度唤醒；建议接 scheduler.tick。 */
  onTaskCreated?: (task: Task) => void | Promise<void>;
  /** cancel_task 需要的 abort 能力；未注入时仍会完成事件 + 表状态。 */
  scheduler?: TaskCanceller | null;
  /** 可注入时钟；默认 Date.now。 */
  now?: () => number;
  /**
   * note 产物正文的实际根目录（默认 <cwd>/data/artifacts）。
   * 与 persistArtifacts 的 artifactsDir 对应，测试/装配层注入。
   */
  artifactsDir?: string;
}

export interface MainToolError {
  code: string;
  message: string;
}

export interface MainToolResult {
  ok: boolean;
  tool: string;
  /** 回喂给模型的文本；ask_user 时为该轮回复内容。 */
  output: string;
  /** 结构化结果，便于测试与后续 UI。 */
  data?: unknown;
  error?: MainToolError;
  /** ask_user 专用：直接作为本轮回复。 */
  reply?: string;
  /** ask_user 专用：主线不转 waiting_input 的决策标记。 */
  decision?: string;
}

interface TaskSummary {
  id: string;
  title: string;
  goal: string;
  status: TaskStatus;
  permission: string;
  revision: number;
  resultJson: string | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 1)}…`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function invalid(tool: string, message: string): MainToolResult {
  return {
    ok: false,
    tool,
    output: `[工具失败] ${ERROR_CODES.E_INVALID_ARGUMENT}: ${message}`,
    error: { code: ERROR_CODES.E_INVALID_ARGUMENT, message },
  };
}

function failure(tool: string, code: string, message: string): MainToolResult {
  return {
    ok: false,
    tool,
    output: `[工具失败] ${code}: ${message}`,
    error: { code, message },
  };
}

function success(tool: string, data: unknown, output?: string): MainToolResult {
  return {
    ok: true,
    tool,
    output: output ?? JSON.stringify(data),
    data,
  };
}

function requiredString(
  tool: string,
  record: Record<string, unknown>,
  field: string,
): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ContractError(
      ERROR_CODES.E_INVALID_ARGUMENT,
      `${tool} 参数 ${field} 必须是非空字符串`,
    );
  }
  return value.trim();
}

function optionalString(
  tool: string,
  record: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ContractError(
      ERROR_CODES.E_INVALID_ARGUMENT,
      `${tool} 参数 ${field} 必须是非空字符串`,
    );
  }
  return value.trim();
}

function optionalInteger(
  tool: string,
  record: Record<string, unknown>,
  field: string,
  min: number,
): number | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    throw new ContractError(
      ERROR_CODES.E_INVALID_ARGUMENT,
      `${tool} 参数 ${field} 必须是 >= ${min} 的整数`,
    );
  }
  return value;
}

function optionalStatus(
  tool: string,
  record: Record<string, unknown>,
): TaskStatus | undefined {
  const value = record.status;
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !(TASK_STATUSES as readonly string[]).includes(value)) {
    throw new ContractError(
      ERROR_CODES.E_INVALID_ARGUMENT,
      `${tool} 参数 status 必须是 ${TASK_STATUSES.join('|')} 之一`,
    );
  }
  return value as TaskStatus;
}

function taskSummary(task: Task): TaskSummary {
  return {
    id: task.id,
    title: task.title,
    goal: task.goal,
    status: task.status,
    permission: task.permission,
    revision: task.revision,
    resultJson: task.resultJson,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
  };
}

function eventPreview(payload: unknown): string {
  try {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return clip(text ?? '', 300);
  } catch {
    return '[unserializable payload]';
  }
}

/**
 * 取任务最近 N 条事件：listEvents 只有升序分页，因此逐页取全再截尾。
 * 与 server 的列表逻辑同构，但不导出、不引 HTTP 类型。
 */
function listRecentTaskEvents(
  db: DatabaseSync,
  taskId: string,
  limit: number,
): Array<{
  seq: number;
  type: string;
  actor: string;
  ts: number;
  payload_preview: string;
}> {
  const collected: ReturnType<typeof listEvents> = [];
  let afterSeq: number | undefined;
  for (;;) {
    const options: ListEventsOptions = { taskId, limit: EVENT_PAGE_SIZE };
    if (afterSeq !== undefined) options.afterSeq = afterSeq;
    const batch = listEvents(db, options);
    collected.push(...batch);
    if (batch.length < EVENT_PAGE_SIZE) break;
    const last = batch[batch.length - 1];
    if (last === undefined) break;
    afterSeq = last.seq;
  }
  return collected.slice(-limit).map((event) => ({
    seq: event.seq,
    type: event.type,
    actor: event.actor,
    ts: event.ts,
    payload_preview: eventPreview(event.payload),
  }));
}

/** 调度唤醒：同步回调立即触发；异步回调的失败只记日志，不改变工具结果。 */
function wakeScheduler(options: MainToolOptions, task: Task): void {
  const callback = options.onTaskCreated;
  if (callback === undefined) return;
  const report = (error: unknown): void => {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'main onTaskCreated failed',
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  };
  try {
    const pending = callback(task);
    if (pending !== undefined && pending !== null) {
      void Promise.resolve(pending).catch(report);
    }
  } catch (error) {
    report(error);
  }
}

/**
 * note 的正文在 data/artifacts/ 受信目录里，用 fs 直读并按字符分页；
 * file/dataset/patch 的正文仍是工作区文件，模型需要用 read_file 任务去看，
 * 这里只返回 sha256/bytes/path 等元数据（见 docs/decisions.md）。
 */
function artifactBody(artifact: Artifact, artifactsDir: string | undefined): string {
  if (artifact.kind !== 'note' || artifact.path === null) return '';
  return readArtifactNoteContent(artifact.path, artifactsDir);
}

function readArtifact(
  options: MainToolOptions,
  tool: string,
  record: Record<string, unknown>,
): MainToolResult {
  const artifactId = requiredString(tool, record, 'artifact_id');
  const offset = optionalInteger(tool, record, 'offset', 0) ?? 0;
  const requestedLimit =
    optionalInteger(tool, record, 'limit', 1) ?? DEFAULT_ARTIFACT_PAGE_CHARS;
  const limit = Math.min(requestedLimit, MAX_ARTIFACT_PAGE_CHARS);

  const artifact = getArtifact(options.db, artifactId);
  if (artifact === null) {
    return failure(tool, ERROR_CODES.E_NOT_FOUND, `产物不存在: ${artifactId}`);
  }

  const content = artifactBody(artifact, options.artifactsDir);
  const startedAt = Math.min(offset, content.length);
  const end = Math.min(content.length, startedAt + limit);
  const page = content.slice(startedAt, end);
  const nextOffset = end < content.length ? end : null;
  const data = {
    artifact_id: artifact.id,
    task_id: artifact.taskId,
    kind: artifact.kind,
    title: artifact.title,
    offset: startedAt,
    limit,
    total_chars: content.length,
    next_offset: nextOffset,
    ...(artifact.path === null ? {} : { path: artifact.path }),
    ...(artifact.sha256 === null ? {} : { sha256: artifact.sha256 }),
    ...(artifact.bytes === null ? {} : { bytes: artifact.bytes }),
    content: page,
  };
  // note 直接回正文；其它类型回元数据 JSON，让模型知道要去工作区 read_file。
  return artifact.kind === 'note' ? success(tool, data, page) : success(tool, data);
}

function remember(
  options: MainToolOptions,
  tool: string,
  record: Record<string, unknown>,
): MainToolResult {
  const key = requiredString(tool, record, 'key');
  const value = requiredString(tool, record, 'value');
  const scope = optionalString(tool, record, 'scope');
  const now = options.now?.() ?? Date.now();
  const fact: Fact = upsertFact(options.db, {
    key,
    value,
    ...(scope === undefined ? {} : { scope }),
    now,
  });
  // SPEC §4.4：memory.fact_upserted 是主线写入长期事实的留痕（全局事件）。
  appendEvent(options.db, {
    type: 'memory.fact_upserted',
    actor: 'main',
    payload: { key: fact.key, value: fact.value },
    ts: now,
  });
  return success(tool, { fact });
}

/**
 * 执行一个主线工具。所有已知失败（参数非法、任务/产物不存在、状态冲突）
 * 都转成 ok:false 的结构化结果；未知异常也不回显原始 message。
 */
export async function executeMainTool(
  name: string,
  args: unknown,
  options: MainToolOptions,
): Promise<MainToolResult> {
  const tool = typeof name === 'string' ? name : String(name);
  try {
    const record = asRecord(args);
    if (record === null) {
      return invalid(tool, `${tool} 需要 JSON 对象参数`);
    }

    switch (tool) {
      case 'list_tasks': {
        const status = optionalStatus(tool, record);
        const limit = optionalInteger(tool, record, 'limit', 1) ?? DEFAULT_TASK_LIMIT;
        const tasks = listTasks(options.db, {
          ...(status === undefined ? {} : { status }),
          limit,
        });
        return success(tool, { count: tasks.length, tasks: tasks.map(taskSummary) });
      }

      case 'create_task': {
        const title = requiredString(tool, record, 'title');
        const goal = requiredString(tool, record, 'goal');
        const permission = record.permission;
        let taskPermission: PermissionMode | undefined;
        if (permission !== undefined) {
          if (
            typeof permission !== 'string' ||
            (permission !== 'read-only' && permission !== 'workspace-write')
          ) {
            return invalid(tool, 'permission 必须是 read-only|workspace-write 之一');
          }
          taskPermission = permission;
        }
        if (options.workspace.trim().length === 0) {
          return failure(tool, ERROR_CODES.E_INVALID_ARGUMENT, '未注入默认工作区');
        }
        const now = options.now?.() ?? Date.now();
        const task = createTask(
          options.db,
          {
            title,
            goal,
            workspace: options.workspace,
            ...(taskPermission === undefined ? {} : { permission: taskPermission }),
            now,
          },
          'main',
        );
        wakeScheduler(options, task);
        return success(tool, { task });
      }

      case 'get_task': {
        const taskId = requiredString(tool, record, 'task_id');
        const task = getTask(options.db, taskId);
        if (task === null) {
          return failure(tool, ERROR_CODES.E_NOT_FOUND, `任务不存在: ${taskId}`);
        }
        return success(tool, {
          task: taskSummary(task),
          recent_events: listRecentTaskEvents(options.db, task.id, RECENT_EVENT_LIMIT),
        });
      }

      case 'cancel_task': {
        const taskId = requiredString(tool, record, 'task_id');
        const reason = optionalString(tool, record, 'reason') ?? '主线取消';
        const now = options.now?.() ?? Date.now();
        const task = cancelTask(options.db, options.scheduler, taskId, reason, now);
        return success(tool, { task: taskSummary(task) });
      }

      case 'retry_task': {
        const taskId = requiredString(tool, record, 'task_id');
        const now = options.now?.() ?? Date.now();
        const task = retryTask(options.db, taskId, now);
        wakeScheduler(options, task);
        return success(tool, { task: taskSummary(task) });
      }

      case 'search_artifacts': {
        const query = requiredString(tool, record, 'query');
        const limit =
          optionalInteger(tool, record, 'limit', 1) ?? DEFAULT_ARTIFACT_SEARCH_LIMIT;
        const hits = searchArtifactsRanked(options.db, {
          query,
          limit,
          now: options.now?.() ?? Date.now(),
        });
        return success(tool, {
          count: hits.length,
          artifacts: hits.map((hit) => ({
            id: hit.id,
            task_id: hit.taskId,
            kind: hit.kind,
            title: hit.title,
            path: hit.path,
            summary: hit.summary,
            snippet: hit.snippet,
            trust: hit.trust,
            score: hit.score,
            created_at: hit.createdAt,
          })),
        });
      }

      case 'read_artifact':
        return readArtifact(options, tool, record);

      case 'remember':
        return remember(options, tool, record);

      case 'recall': {
        const rawQuery = record.query;
        if (rawQuery !== undefined && typeof rawQuery !== 'string') {
          return invalid(tool, 'query 必须是字符串');
        }
        const facts = recallFacts(options.db, { query: rawQuery ?? '' });
        return success(tool, { count: facts.length, facts });
      }

      case 'ask_user': {
        const question = requiredString(tool, record, 'question');
        const reply = `需要向用户澄清：${question}`;
        // 主线语义：直接问，不进入 waiting_input；decision 标记便于上层/测试识别。
        return {
          ok: true,
          tool,
          output: reply,
          data: { question, action: 'ask_user_direct_reply' },
          reply,
          decision: 'ask_user_direct_reply',
        };
      }

      default:
        return failure(tool, ERROR_CODES.E_INVALID_ARGUMENT, `未知工具: ${tool}`);
    }
  } catch (error) {
    if (error instanceof ContractError) {
      return failure(tool, error.code, error.message);
    }
    // 未知异常不回显原始 message，避免把路径/key 带进对话或日志。
    return failure(tool, ERROR_CODES.E_INTERNAL, '主线工具执行异常（未分类错误）');
  }
}
