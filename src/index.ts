/**
 * 启动装配（SPEC §7 M4-02）：.env → SQLite → reaper → scheduler → Fastify。
 *
 * 只做装配与生命周期，不写业务逻辑。所有配置可由环境变量覆盖：
 * - PORT          监听端口，默认 4310
 * - WORKSPACE_DIR 默认工作区（设置 workspaceDir 优先），默认 <repo>/workspace
 * - DATA_DIR      数据目录，默认 <repo>/data
 * - DB_PATH       数据库文件，默认 <DATA_DIR>/task-terminal.db
 * - DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL / DEEPSEEK_MODEL
 *
 * 安全：.env 只解析、不回显；日志与错误信息都不包含 key 值。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AGENT_TOOL_SPECS } from './agent/loop.ts';
import { installWebToolSpecs } from './agent/tools/web.ts';
import { DeepSeekProvider } from './providers/deepseek.ts';
import { reapExpiredRuns } from './runtime/reaper.ts';
import { createScheduler } from './runtime/scheduler.ts';
import { createApp } from './server/index.ts';
import { openDatabase } from './store/migrate.ts';
import {
  getEffectiveApiKey,
  resolveDefaultWorkspace,
} from './store/settings.ts';

    // M11-01：官方联网工具只在启动装配层加入子智能体工具表；executeTool 的
    // TOOL_SPECS 仍保持 M3 验收时的六件套，既有断言零改动。
    installWebToolSpecs(AGENT_TOOL_SPECS);

/** 端口常量；SPEC 未指定端口号，取 4310 并由 PORT 覆盖。 */
export const DEFAULT_PORT = 4310;
export const DEFAULT_HOST = '127.0.0.1';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

interface StartupConfig {
  port: number;
  /** 启动时 .env 快照；可为空（M12-01 不再因缺 key 退出）。 */
  apiKey: string | undefined;
  baseUrl: string | undefined;
  model: string | undefined;
  dataDir: string;
  dbPath: string;
}

/** 手动解析 .env（仓库根）；已存在的环境变量优先，不打印任何值。 */
function loadEnvFile(file: string): void {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(trimmed);
    if (match === null) continue;
    const key = match[1];
    let value = match[2] ?? '';
    if (key === undefined) continue;
    value = value.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function envText(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PORT;
  if (!/^\d+$/u.test(raw)) {
    throw new Error(`PORT 必须是 1-65535 的整数，实际为非法值`);
  }
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT 必须是 1-65535 的整数');
  }
  return port;
}

function readConfig(): StartupConfig {
  loadEnvFile(join(REPO_ROOT, '.env'));

  // M12-01：key 可以完全缺失——服务照常启动，设置页可随时补填。
  const apiKey = envText('DEEPSEEK_API_KEY');

  const dataDir = envText('DATA_DIR') ?? join(REPO_ROOT, 'data');
  const dbPath = envText('DB_PATH') ?? join(dataDir, 'task-terminal.db');

  return {
    port: parsePort(envText('PORT')),
    apiKey,
    baseUrl: envText('DEEPSEEK_BASE_URL'),
    model: envText('DEEPSEEK_MODEL'),
    dataDir,
    dbPath,
  };
}

function logInfo(message: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: 'info', msg: message, ...fields }));
}

function logWarn(message: string, fields: Record<string, unknown> = {}): void {
  console.warn(JSON.stringify({ level: 'warn', msg: message, ...fields }));
}

async function main(): Promise<void> {
  const config = readConfig();

  // M14-01：dist/（pnpm build 产物）存在时交给 server 托管；缺失则纯 API 模式。
  const webDir: string | null = existsSync(join(REPO_ROOT, 'dist', 'index.html'))
    ? join(REPO_ROOT, 'dist')
    : null;

  const db = openDatabase(config.dbPath);
  try {
    // 启动装配与每次请求共用同一解析顺序：settings > env WORKSPACE_DIR > <repo>/workspace。
    const workspace = resolveDefaultWorkspace(db);
    mkdirSync(workspace, { recursive: true });

    // 显式跑一次启动恢复；调度器内不再重复 reap。
    const reaped = reapExpiredRuns(db);
    if (reaped.length > 0) {
      logInfo('reaped expired runs', { count: reaped.length });
    }

    const startupApiKey = getEffectiveApiKey(db);
    // M12-01：provider 收解析函数，每轮对话/每次请求重新取当前生效 key；
    // 构造时允许为空，真正发起请求时才按 E_PROVIDER_AUTH 拒绝。
    const provider = new DeepSeekProvider({
      apiKey: () => getEffectiveApiKey(db) ?? '',
      ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
      ...(config.model === undefined ? {} : { model: config.model }),
    });
    // ctx 用变量而不是内联字面量：scheduler 的 LoopToolContextOptions 是
    // Pick 白名单，运行时靠 ...options.ctx 原样透传 webTools；这样既不改
    // scheduler，也不把 key 落到任何日志/事件里。
    // webTools 的 apiKey 用 getter：任务级每次读取当前设置，改 key 即时生效。
    // （旧装配写法 apiKey: config.apiKey 只保留在注释里，避免误导为启动快照。）
    const schedulerCtx = {
      outputDir: join(config.dataDir, 'tool-outputs'),
      webTools: {
        get apiKey(): string {
          return getEffectiveApiKey(db) ?? config.apiKey ?? '';
        },
        ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
      },
    };
    const scheduler = createScheduler({
      db,
      provider,
      ctx: schedulerCtx,
      reapOnStart: false,
      // 无 key 时 tick 返回 no-key：任务留在 queued，不写 run/事件。
      getApiKey: () => getEffectiveApiKey(db),
    });
    const app = createApp({
      db,
      scheduler,
      mainAi: { provider },
      // 生产装配显式开启：无 key 时 /chat 直接 503，而不是把空 key 交给 provider。
      requireApiKey: true,
      // M14-01：dist/ 存在时由本进程直接托管前端，单进程即完整应用。
      ...(webDir === null ? {} : { webDir }),
    });

    if (startupApiKey === null) {
      logWarn('未配置 API Key：对话与任务执行不可用，请在设置中配置', {
        ai: 'disabled',
      });
    }

    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      logInfo('shutting down', { signal });
      try {
        await scheduler.shutdown({ abort: true });
        await app.close();
      } finally {
        db.close();
      }
      logInfo('shutdown complete', { signal });
    };

    process.once('SIGINT', () => {
      void shutdown('SIGINT');
    });
    process.once('SIGTERM', () => {
      void shutdown('SIGTERM');
    });

    await app.listen({ host: DEFAULT_HOST, port: config.port });
    logInfo('task-terminal listening', {
      url: `http://${DEFAULT_HOST}:${String(config.port)}`,
      db: config.dbPath,
      workspace,
      ai: startupApiKey === null ? 'disabled' : 'enabled',
      web: webDir === null ? 'off' : 'on',
    });
  } catch (error) {
    db.close();
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      level: 'error',
      msg: '启动失败',
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
});
