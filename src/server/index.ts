/**
 * 服务层（SPEC §4.1 / §7 M4-02）：REST 薄层 + SSE 事件流。
 *
 * 边界：本文件只做参数校验、调用 store/runtime 既有函数、JSON 编解码。
 * 不判断状态机转移、不拼 SQL、不写事件编排——创建/取消/重试的事件顺序
 * 统一由 runtime/ops.ts 负责（M5-01 抽取，行为与 M4-02 等价）。
 *
 * SSE 的实时源是 events 表轮询（默认 150ms）：单用户量级足够，且与
 * “事件是唯一真相源”一致；不引入 ws/额外依赖，断点续传只依赖 seq。
 */
import type { DatabaseSync } from 'node:sqlite';

import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
} from 'fastify';

import { ContractError, ERROR_CODES, type ErrorCode } from '../core/errors.ts';
import {
  PERMISSION_MODES,
  TASK_STATUSES,
  type PermissionMode,
  type Task,
} from '../core/types.ts';
import { cancelTask, createTask, retryTask } from '../runtime/ops.ts';
import type { Scheduler } from '../runtime/scheduler.ts';
import { searchArtifacts } from '../store/artifacts.ts';
import { listEvents, type ListEventsOptions } from '../store/events.ts';
import { getTask, listTasks } from '../store/repo.ts';

export interface SseOptions {
  /** 轮询 events 表间隔；默认 150ms。 */
  pollIntervalMs?: number;
  /** 心跳注释行间隔；默认 15s。 */
  heartbeatMs?: number;
  /** 单次补历史/轮询的批量上限；默认 500。 */
  pageSize?: number;
  /** 每次轮询 tick 回调（诊断/测试用，不参与业务）。 */
  onPoll?: () => void;
}

export interface CreateAppOptions {
  db: DatabaseSync;
  scheduler: Scheduler;
  /** POST /tasks 未带 workspace 时的默认工作区（由启动装配注入）。 */
  defaultWorkspace: string;
  /** 可注入时钟；默认 Date.now。 */
  now?: () => number;
  sse?: SseOptions;
}

const DEFAULT_POLL_INTERVAL_MS = 150;
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_SSE_PAGE_SIZE = 500;
const RECENT_EVENT_LIMIT = 20;
const EVENT_PAGE_SIZE = 500;

interface ErrorBody {
  error: { code: string; message: string };
}

function errorBody(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}

function invalid(message: string): never {
  throw new ContractError(ERROR_CODES.E_INVALID_ARGUMENT, message);
}

function notFound(message: string): never {
  throw new ContractError(ERROR_CODES.E_NOT_FOUND, message);
}

function httpStatusFor(code: ErrorCode): number {
  switch (code) {
    case ERROR_CODES.E_INVALID_ARGUMENT:
      return 400;
    case ERROR_CODES.E_NOT_FOUND:
      return 404;
    case ERROR_CODES.E_CONFLICT:
    case ERROR_CODES.E_INVALID_TRANSITION:
      return 409;
    case ERROR_CODES.E_WORKSPACE_ESCAPE:
    case ERROR_CODES.E_COMMAND_DENIED:
      return 403;
    case ERROR_CODES.E_BUDGET_EXCEEDED:
      return 429;
    default:
      return 500;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readQuery(request: FastifyRequest): Record<string, unknown> {
  return asRecord(request.query) ?? {};
}

function readJsonBody(request: FastifyRequest): Record<string, unknown> {
  const body = asRecord(request.body);
  if (body === null) invalid('请求体必须是 JSON 对象');
  return body;
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    invalid(`${field} 必须是非空字符串`);
  }
  return value.trim();
}

function optionalString(raw: unknown, name: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    invalid(`${name} 必须是非空字符串`);
  }
  return raw.trim();
}

function parseNonNegativeInteger(raw: unknown, name: string): number {
  if (typeof raw !== 'string' || !/^(0|[1-9]\d*)$/.test(raw)) {
    invalid(`${name} 必须是整数且 >= 0`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) invalid(`${name} 超出安全整数范围`);
  return value;
}

function parsePositiveInteger(raw: unknown, name: string): number {
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) {
    invalid(`${name} 必须是正整数`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) invalid(`${name} 超出安全整数范围`);
  return value;
}

function parseOptionalLimit(raw: unknown, defaultValue: number): number {
  return raw === undefined ? defaultValue : parsePositiveInteger(raw, 'limit');
}

function parseOptionalStatus(raw: unknown): Task['status'] | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !(TASK_STATUSES as readonly string[]).includes(raw)) {
    invalid(`status 必须是 ${TASK_STATUSES.join('|')} 之一`);
  }
  return raw as Task['status'];
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function logInfo(message: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: 'info', msg: message, ...fields }));
}

function logError(message: string, fields: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ level: 'error', msg: message, ...fields }));
}

/** fire-and-forget：HTTP 响应不等整轮 agent 执行。 */
function wakeScheduler(scheduler: Scheduler): void {
  void scheduler.tick().then(
    (result) => {
      if (result.started) {
        logInfo('scheduler tick finished', {
          taskId: result.taskId,
          runId: result.runId,
          outcome: result.outcome.status,
        });
      }
    },
    (error: unknown) => {
      logError('scheduler tick failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    },
  );
}

/** 取任务最近 N 条事件：listEvents 只有升序分页，因此逐页取全再截尾。 */
function listRecentTaskEvents(db: DatabaseSync, taskId: string, limit: number): ReturnType<typeof listEvents> {
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
  return collected.slice(-limit);
}

function parseSseTaskId(raw: unknown): string | undefined {
  return optionalString(raw, 'taskId');
}

interface SseConnection {
  close(): void;
}

export function createApp(options: CreateAppOptions): FastifyInstance {
  const { db, scheduler, defaultWorkspace } = options;
  const clock = options.now ?? Date.now;
  const sseOptions = options.sse ?? {};
  const pollIntervalMs = positiveOr(sseOptions.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
  const heartbeatMs = positiveOr(sseOptions.heartbeatMs, DEFAULT_HEARTBEAT_MS);
  const pageSize = positiveOr(sseOptions.pageSize, DEFAULT_SSE_PAGE_SIZE);
  const onPoll = sseOptions.onPoll;

  const app = Fastify({ logger: false, bodyLimit: 1_048_576 });
  const connections = new Set<SseConnection>();

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ContractError) {
      const status = httpStatusFor(error.code);
      if (status >= 500) {
        logError('request failed', {
          method: request.method,
          url: request.url,
          code: error.code,
        });
        reply.code(500).send(errorBody(ERROR_CODES.E_INTERNAL, '服务器内部错误'));
        return;
      }
      reply.code(status).send(errorBody(error.code, error.message));
      return;
    }

    const fastifyError = error as { statusCode?: unknown; code?: unknown; message?: unknown };
    const statusCode =
      typeof fastifyError.statusCode === 'number' && fastifyError.statusCode >= 400
        ? fastifyError.statusCode
        : 500;
    if (statusCode >= 500) {
      logError('request failed', {
        method: request.method,
        url: request.url,
        code:
          typeof fastifyError.code === 'string'
            ? fastifyError.code
            : ERROR_CODES.E_INTERNAL,
      });
      reply.code(500).send(errorBody(ERROR_CODES.E_INTERNAL, '服务器内部错误'));
      return;
    }
    const code =
      statusCode === 404
        ? ERROR_CODES.E_NOT_FOUND
        : statusCode === 409
          ? ERROR_CODES.E_CONFLICT
          : ERROR_CODES.E_INVALID_ARGUMENT;
    const message =
      typeof fastifyError.message === 'string' && fastifyError.message.length > 0
        ? fastifyError.message
        : '请求参数错误';
    reply.code(statusCode).send(errorBody(code, message));
  });

  app.setNotFoundHandler((request, reply) => {
    reply
      .code(404)
      .send(errorBody(ERROR_CODES.E_NOT_FOUND, `未知路由: ${request.method} ${request.url}`));
  });

  // ── tasks ──────────────────────────────────────────────────────

  app.post('/tasks', async (request, reply) => {
    const body = readJsonBody(request);

    const title = requiredString(body, 'title');
    const goal = requiredString(body, 'goal');

    let permission: PermissionMode | undefined;
    if (body.permission !== undefined) {
      if (
        typeof body.permission !== 'string' ||
        !(PERMISSION_MODES as readonly string[]).includes(body.permission)
      ) {
        invalid(`permission 必须是 ${PERMISSION_MODES.join('|')} 之一`);
      }
      permission = body.permission as PermissionMode;
    }

    const workspace = optionalString(body.workspace, 'workspace') ?? defaultWorkspace;
    const now = clock();

    const task = createTask(
      db,
      {
        title,
        goal,
        workspace,
        ...(permission === undefined ? {} : { permission }),
        now,
      },
      'user',
    );

    reply.code(201).send(task);
    wakeScheduler(scheduler);
  });

  app.get('/tasks', async (request) => {
    const query = readQuery(request);
    const status = parseOptionalStatus(query.status);
    const limit = parseOptionalLimit(query.limit, 100);
    return listTasks(db, {
      ...(status === undefined ? {} : { status }),
      limit,
    });
  });

  app.get('/tasks/:id', async (request, reply) => {
    const params = asRecord(request.params) ?? {};
    const id = params.id;
    if (typeof id !== 'string' || id.length === 0) invalid('任务 id 不能为空');
    const task = getTask(db, id);
    if (task === null) notFound(`任务不存在: ${id}`);
    reply.send({ task, events: listRecentTaskEvents(db, task.id, RECENT_EVENT_LIMIT) });
  });

  app.post('/tasks/:id/cancel', async (request, reply) => {
    const params = asRecord(request.params) ?? {};
    const id = params.id;
    if (typeof id !== 'string' || id.length === 0) invalid('任务 id 不能为空');

    const body = asRecord(request.body);
    const rawReason = body === null ? undefined : body.reason;

    const cancelled = cancelTask(db, scheduler, id, rawReason, clock());
    reply.send(cancelled);
  });

  app.post('/tasks/:id/retry', async (request, reply) => {
    const params = asRecord(request.params) ?? {};
    const id = params.id;
    if (typeof id !== 'string' || id.length === 0) invalid('任务 id 不能为空');

    const queued = retryTask(db, id, clock());
    reply.send(queued);
    wakeScheduler(scheduler);
  });

  // ── artifacts ──────────────────────────────────────────────────

  app.get('/artifacts', async (request) => {
    const query = readQuery(request);
    const rawQuery = query.query;
    if (rawQuery !== undefined && typeof rawQuery !== 'string') {
      invalid('query 必须是字符串');
    }
    const limit = parseOptionalLimit(query.limit, 10);
    return searchArtifacts(db, rawQuery ?? '', limit);
  });

  // ── SSE ────────────────────────────────────────────────────────

  app.get('/events', async (request, reply) => {
    const query = readQuery(request);
    const after =
      query.after === undefined ? 0 : parseNonNegativeInteger(query.after, 'after');
    const taskId = parseSseTaskId(query.taskId);

    const raw = reply.raw;
    reply.hijack();
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });

    let closed = false;
    let lastSeq = after;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

    const write = (chunk: string): void => {
      if (closed || raw.writableEnded || raw.destroyed) return;
      raw.write(chunk);
    };

    const writeEvent = (event: {
      seq: number;
      type: string;
      payload: unknown;
    }): void => {
      write(
        `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`,
      );
    };

    const pump = (): void => {
      if (closed) return;
      try {
        for (;;) {
          const listOptions: ListEventsOptions = {
            afterSeq: lastSeq,
            limit: pageSize,
          };
          if (taskId !== undefined) listOptions.taskId = taskId;
          const batch = listEvents(db, listOptions);
          for (const event of batch) {
            writeEvent(event);
            lastSeq = event.seq;
          }
          if (batch.length < pageSize) break;
        }
      } catch (error) {
        logError('sse poll failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        close();
      }
    };

    const close = (): void => {
      if (closed) return;
      closed = true;
      if (pollTimer !== undefined) clearInterval(pollTimer);
      if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
      pollTimer = undefined;
      heartbeatTimer = undefined;
      raw.removeListener('close', close);
      raw.removeListener('error', close);
      connections.delete(connection);
      if (!raw.writableEnded && !raw.destroyed) raw.end();
    };

    const connection: SseConnection = { close };
    connections.add(connection);
    raw.on('close', close);
    raw.on('error', close);

    // 先一次性补齐 after 之后的历史，再进入实时轮询；全同步，不会与轮询交错。
    pump();
    if (closed) return;

    pollTimer = setInterval(() => {
      if (onPoll !== undefined) onPoll();
      pump();
    }, pollIntervalMs);
    pollTimer.unref?.();

    heartbeatTimer = setInterval(() => {
      write(': ping\n\n');
    }, heartbeatMs);
    heartbeatTimer.unref?.();
  });

  const closeAllSse = (): void => {
    for (const connection of [...connections]) connection.close();
  };
  // preClose 先于 http server 关闭执行，避免 keep-alive/SSE 连接拖住 app.close()。
  app.addHook('preClose', async () => {
    closeAllSse();
  });
  app.addHook('onClose', async () => {
    closeAllSse();
  });

  return app;
}

export default createApp;
