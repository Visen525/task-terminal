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
import {
  accessSync,
  constants as fsConstants,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { join, parse as parsePath, resolve as resolvePath } from 'node:path';
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
import { runMainTurn } from '../agent/main-loop.ts';
import type { LlmProvider } from '../providers/types.ts';
import { cancelTask, createTask, retryTask } from '../runtime/ops.ts';
import type { Scheduler } from '../runtime/scheduler.ts';
import { getLocalDayRange } from '../runtime/watchdog.ts';
import {
  ARTIFACT_KINDS,
  getArtifact,
  listArtifacts,
  searchArtifacts,
  type ArtifactKind,
} from '../store/artifacts.ts';
import { deleteFact, listFacts } from '../store/facts.ts';
import { listEvents, type ListEventsOptions } from '../store/events.ts';
import { getDailyUsage } from '../store/llm-calls.ts';
import {
  findAttachmentById,
  listRecentMessages,
} from '../store/messages.ts';
import { getTask, listTasks } from '../store/repo.ts';
import {
  getSettings,
  resolveDefaultWorkspace,
  saveSettings,
  validateSettingsInput,
} from '../store/settings.ts';
import { isUlid } from '../store/ulid.ts';
import {
  buildChatUserContent,
  CHAT_BODY_LIMIT_BYTES,
  findUploadById,
  guessMimeFromFilename,
  saveChatAttachments,
} from './uploads.ts';

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
  /**
   * POST /tasks / POST /chat 未带 workspace 时的默认工作区。
   * 缺省时每次请求走 resolveDefaultWorkspace(db)（settings > env > <repo>/workspace）；
   * 测试/装配层显式注入时以注入值为准。
   */
  defaultWorkspace?: string;
  /**
   * 主线 AI 依赖（M6-03）；缺省时 POST /chat 返回 500。
   * 只注入 provider，db / scheduler / workspace 仍由本层持有。
   */
  mainAi?: { provider: LlmProvider };
  /** 对话附件落盘根目录；默认 <cwd>/data/uploads（测试可注入临时目录）。 */
  uploadsDir?: string;
  /** 可注入时钟；默认 Date.now。 */
  now?: () => number;
  sse?: SseOptions;
}

const DEFAULT_POLL_INTERVAL_MS = 150;
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_SSE_PAGE_SIZE = 500;
const DEFAULT_MESSAGES_LIMIT = 50;
const RECENT_EVENT_LIMIT = 20;
const EVENT_PAGE_SIZE = 500;
/** /fs/browse 单次最多返回的目录数（M10-01）。 */
const BROWSE_LIMIT = 500;

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

/**
 * POST /chat 的 message：普通消息仍必须非空；只带附件（如单发一张图）时
 * 允许空文本。非字符串一律 400；错误文案不回显输入。
 */
function parseChatMessage(raw: unknown, hasAttachments: boolean): string {
  if (raw === undefined) {
    if (hasAttachments) return '';
    invalid('message 必须是非空字符串');
  }
  if (typeof raw !== 'string') invalid('message 必须是字符串');
  const message = raw.trim();
  if (message.length === 0 && !hasAttachments) invalid('message 必须是非空字符串');
  return message;
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

/** 产物 kind 过滤参数：缺省不过滤，非法值 400。 */
function parseOptionalArtifactKind(raw: unknown): ArtifactKind | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !(ARTIFACT_KINDS as readonly string[]).includes(raw)) {
    invalid(`kind 必须是 ${ARTIFACT_KINDS.join('|')} 之一`);
  }
  return raw as ArtifactKind;
}

/** 布尔 query 参数：空串/true/1 为真，false/0 为假；其余一律 400。 */
function parseOptionalBoolean(raw: unknown, name: string): boolean {
  if (raw === undefined) return false;
  if (typeof raw !== 'string') invalid(`${name} 必须是 true 或 false`);
  if (raw === '' || raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  invalid(`${name} 必须是 true 或 false`);
}

/** 事实 id：f_ + 26 位 ULID；错误信息不回显用户输入。 */
function parseFactId(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.startsWith('f_') || !isUlid(raw.slice(2))) {
    invalid('事实 id 格式不合法');
  }
  return raw;
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

/** 目录是否可进入：只做权限探测，不读文件内容。 */
function canEnterDirectory(path: string): boolean {
  try {
    accessSync(path, fsConstants.R_OK | fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 解析 /fs/browse?path=：缺省取 process.cwd() 所在盘根；传入值必须真实存在
 * 且是目录。错误信息不回显用户路径。
 */
function resolveBrowseTarget(raw: unknown): string {
  if (raw === undefined) return parsePath(process.cwd()).root;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    invalid('path 必须是非空字符串');
  }
  let resolved: string;
  try {
    resolved = realpathSync(resolvePath(raw.trim()));
  } catch {
    invalid('path 不存在或不可访问');
  }
  try {
    if (!statSync(resolved).isDirectory()) invalid('path 不是目录');
    // 目录本身可读/可进入才允许列举，避免后续 readdir 才暴露权限问题。
    accessSync(resolved, fsConstants.R_OK | fsConstants.X_OK);
  } catch (error) {
    if (error instanceof ContractError) throw error;
    invalid('path 不可访问');
  }
  return resolved;
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

/** 在途对话流：优雅退出时需要主动中止并结束 HTTP 响应。 */
interface ActiveChatStream {
  abort(): void;
  end(): void;
}

export function createApp(options: CreateAppOptions): FastifyInstance {
  const { db, scheduler } = options;
  const injectedWorkspace = options.defaultWorkspace;
  /**
   * 请求时的默认工作区：settings 永远优先；未设置时保留测试/装配注入值，
   * 最后由 resolveDefaultWorkspace 走 env WORKSPACE_DIR > <repo>/workspace。
   */
  const appWorkspace = (): string => {
    const stored = getSettings(db).workspaceDir;
    if (stored !== null) return stored;
    return injectedWorkspace ?? resolveDefaultWorkspace(db);
  };
  const clock = options.now ?? Date.now;
  const uploadsDir = options.uploadsDir ?? join(process.cwd(), 'data', 'uploads');
  const sseOptions = options.sse ?? {};
  const pollIntervalMs = positiveOr(sseOptions.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
  const heartbeatMs = positiveOr(sseOptions.heartbeatMs, DEFAULT_HEARTBEAT_MS);
  const pageSize = positiveOr(sseOptions.pageSize, DEFAULT_SSE_PAGE_SIZE);
  const onPoll = sseOptions.onPoll;

  const app = Fastify({ logger: false, bodyLimit: 1_048_576 });
  const connections = new Set<SseConnection>();
  const activeChats = new Set<ActiveChatStream>();

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

    const workspace = optionalString(body.workspace, 'workspace') ?? appWorkspace();
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

    // 空白 query 与缺省同义：浏览模式；带 query 仍走既有 FTS 检索。
    const queryText = typeof rawQuery === 'string' ? rawQuery.trim() : '';
    if (queryText.length === 0) {
      const kind = parseOptionalArtifactKind(query.kind);
      const limit = parseOptionalLimit(query.limit, 50);
      const offset =
        query.offset === undefined ? 0 : parseNonNegativeInteger(query.offset, 'offset');
      const page = listArtifacts(db, { limit, offset, ...(kind === undefined ? {} : { kind }) });
      return { mode: 'browse' as const, total: page.total, items: page.items };
    }

    const limit = parseOptionalLimit(query.limit, 10);
    const items = searchArtifacts(db, queryText, limit);
    return { mode: 'search' as const, total: items.length, items };
  });

  app.get('/artifacts/:id', async (request, reply) => {
    const params = asRecord(request.params) ?? {};
    const id = params.id;
    if (typeof id !== 'string' || id.length === 0) invalid('产物 id 不能为空');
    const artifact = getArtifact(db, id);
    if (artifact === null) notFound(`产物不存在: ${id}`);
    reply.send(artifact);
  });

  // ── 长期记忆与设置概览（M9-02） ───────────────────────────────

  app.get('/facts', async (request) => {
    const query = readQuery(request);
    const includeSuperseded = parseOptionalBoolean(query.includeSuperseded, 'includeSuperseded');
    return listFacts(db, { includeSuperseded });
  });

  app.delete('/facts/:id', async (request, reply) => {
    const params = asRecord(request.params) ?? {};
    const id = parseFactId(params.id);
    const deleted = deleteFact(db, id);
    if (deleted === 0) notFound('事实不存在');
    reply.send({ deleted });
  });

  app.get('/settings/overview', async () => {
    const settings = getSettings(db);
    const { startMs, endMs } = getLocalDayRange(clock());
    const usage = db
      .prepare(
        `SELECT COALESCE(SUM(input_tokens), 0) AS input,
                COALESCE(SUM(cached_tokens), 0) AS cached,
                COALESCE(SUM(output_tokens), 0) AS output
           FROM llm_calls
          WHERE ts >= ? AND ts < ?`,
      )
      .get(startMs, endMs) as unknown as
      | { input: number | bigint; cached: number | bigint; output: number | bigint }
      | undefined;

    const taskRow = db.prepare('SELECT COUNT(*) AS count FROM tasks').get() as unknown as
      | { count: number | bigint }
      | undefined;
    const artifactRow = db.prepare('SELECT COUNT(*) AS count FROM artifacts').get() as unknown as
      | { count: number | bigint }
      | undefined;
    const factRow = db
      .prepare('SELECT COUNT(*) AS count FROM memory_facts')
      .get() as unknown as { count: number | bigint } | undefined;

    return {
      model: settings.main.model,
      dailyBudgetTokens: settings.dailyBudgetTokens,
      todayUsage: {
        input: Number(usage?.input ?? 0),
        cached: Number(usage?.cached ?? 0),
        output: Number(usage?.output ?? 0),
        total: getDailyUsage(db, startMs, endMs),
      },
      counts: {
        tasks: Number(taskRow?.count ?? 0),
        artifacts: Number(artifactRow?.count ?? 0),
        facts: Number(factRow?.count ?? 0),
      },
    };
  });

  // ── 应用设置与目录浏览（M10-01） ─────────────────────────────

  app.get('/settings', async () => getSettings(db));

  app.put('/settings', async (request) => {
    const body = readJsonBody(request);
    // 先校验再写：非法字段不落库；错误信息带字段路径（400）。
    const patch = validateSettingsInput(body);
    return saveSettings(db, patch, clock());
  });

  /**
   * GET /fs/browse?path=：只列目录名与“是否可进入”，不返回文件/文件内容。
   * 缺省 path 为 process.cwd() 所在盘根；最多 500 条，超出以 truncated 标注。
   */
  app.get('/fs/browse', async (request) => {
    const query = readQuery(request);
    const target = resolveBrowseTarget(query.path);

    let directories: Array<{ name: string }>;
    try {
      directories = readdirSync(target, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({ name: entry.name }))
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      invalid('path 不可访问');
    }

    const page = directories.slice(0, BROWSE_LIMIT);
    return {
      path: target,
      entries: page.map((entry) => ({
        name: entry.name,
        enterable: canEnterDirectory(join(target, entry.name)),
      })),
      total: directories.length,
      limit: BROWSE_LIMIT,
      truncated: directories.length > BROWSE_LIMIT,
    };
  });

  // ── 主线对话 ───────────────────────────────────────────────────

  app.get('/messages', async (request) => {
    const query = readQuery(request);
    const limit = parseOptionalLimit(query.limit, DEFAULT_MESSAGES_LIMIT);
    return listRecentMessages(db, limit).map((message) => ({
      id: message.id,
      taskId: message.taskId,
      seq: message.seq,
      role: message.role,
      // v1.1 契约字段；content 保留给 M6 起的既有前端/断言，值相同。
      text: message.content,
      content: message.content,
      tokens: message.tokens,
      ts: message.ts,
      ...(message.attachments === undefined
        ? {}
        : { attachments: message.attachments }),
    }));
  });

  /**
   * GET /uploads/:id（M9-03）：按 ULID 前缀在 uploads 根目录定位并内联下发。
   * 参数只允许 Crockford Base32，文件路径 resolve 后必须仍在 uploads 内；
   * 任何不合法/不存在/越界路径统一 404，不泄露本机路径。
   */
  app.get('/uploads/:id', async (request, reply) => {
    const params = asRecord(request.params) ?? {};
    const rawId = params.id;
    if (typeof rawId !== 'string') notFound('附件不存在');
    const located = findUploadById(uploadsDir, rawId);
    if (located === null) notFound('附件不存在');

    const meta = findAttachmentById(db, located.id);
    const mime = meta?.mime ?? guessMimeFromFilename(located.filename);
    let data: Buffer;
    try {
      data = readFileSync(located.fullPath);
    } catch {
      notFound('附件不存在');
    }
    reply
      .header('Content-Disposition', 'inline')
      .header('X-Content-Type-Options', 'nosniff')
      .type(mime);
    return reply.send(data);
  });

  /**
   * POST /chat：SSE 流式主线对话（M6-03）。
   *
   * 协议：HTTP 200 + text/event-stream
   *   event: delta  data: {text}
   *   event: done   data: {reply, usage}
   *   event: error  data: {code, message}（随后结束，HTTP 仍是 200）
   * 参数错误在建立流之前由全局错误处理器返回 400 JSON。
   */
  app.post('/chat', { bodyLimit: CHAT_BODY_LIMIT_BYTES }, async (request, reply) => {
    const body = readJsonBody(request);
    const rawAttachments = body.attachments;
    const hasAttachments = Array.isArray(rawAttachments) && rawAttachments.length > 0;
    const message = parseChatMessage(body.message, hasAttachments);
    const mainAi = options.mainAi;
    if (mainAi === undefined) {
      throw new ContractError(ERROR_CODES.E_INTERNAL, '主线 AI 未装配，POST /chat 不可用');
    }

    // 附件校验/落盘在建立 SSE 之前完成：违规直接走全局 400 JSON。
    const saved = saveChatAttachments(rawAttachments, uploadsDir, clock());
    const userContent = buildChatUserContent(message, saved);

    const raw = reply.raw;
    reply.hijack();
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    // 立即吐注释行：既冲刷响应头（fetch 在首 token 前即可拿到流），也让客户端确认已连上。
    raw.write(': connected\n\n');

    const controller = new AbortController();
    let closed = false;

    const write = (chunk: string): void => {
      if (closed || raw.writableEnded || raw.destroyed) return;
      raw.write(chunk);
    };

    const writeDelta = (text: string): void => {
      write(`event: delta\ndata: ${JSON.stringify({ text })}\n\n`);
    };

    const writeDone = (data: unknown): void => {
      write(`event: done\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const writeStreamError = (data: unknown): void => {
      write(`event: error\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const finish = (): void => {
      if (closed) return;
      closed = true;
      activeChats.delete(stream);
      if (!raw.writableEnded && !raw.destroyed) raw.end();
    };

    const stream: ActiveChatStream = {
      abort: () => {
        if (!controller.signal.aborted) {
          controller.abort(new Error('服务关闭，已结束在途对话'));
        }
      },
      end: finish,
    };

    const handleDisconnect = (): void => {
      if (closed) return;
      closed = true;
      activeChats.delete(stream);
      if (!controller.signal.aborted) {
        controller.abort(new Error('客户端连接已断开'));
      }
    };
    activeChats.add(stream);
    raw.on('close', handleDisconnect);
    raw.on('error', handleDisconnect);

    try {
      const result = await runMainTurn({
        db,
        provider: mainAi.provider,
        ...(saved.length === 0
          ? { userMessage: message }
          : {
              userContent: userContent.parts,
              userText: userContent.text,
              userAttachments: saved.map((item) => item.attachment),
            }),
        workspace: appWorkspace(),
        signal: controller.signal,
        onTextDelta: (text) => {
          writeDelta(text);
        },
        onTaskCreated: () => {
          wakeScheduler(scheduler);
        },
      });
      writeDone({ reply: result.reply, usage: result.usage });
    } catch (error) {
      if (!closed) {
        const contract = error instanceof ContractError ? error : null;
        const code: ErrorCode = contract?.code ?? ERROR_CODES.E_INTERNAL;
        // 只记录错误码与脱敏后的消息；provider 层已保证不回显 key/Authorization。
        logError('chat stream failed', {
          code,
          error: error instanceof Error ? error.message : String(error),
        });
        writeStreamError({
          code,
          message: contract?.message ?? '对话失败，请稍后重试',
        });
      }
    } finally {
      raw.removeListener('close', handleDisconnect);
      raw.removeListener('error', handleDisconnect);
      finish();
    }
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
  const closeAllChats = (): void => {
    for (const stream of [...activeChats]) {
      stream.abort();
      stream.end();
    }
  };
  // preClose 先于 http server 关闭执行，避免 keep-alive/SSE/对话流拖住 app.close()。
  app.addHook('preClose', async () => {
    closeAllChats();
    closeAllSse();
  });
  app.addHook('onClose', async () => {
    closeAllChats();
    closeAllSse();
  });

  return app;
}

export default createApp;
