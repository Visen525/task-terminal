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
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DeepSeekProvider } from './providers/deepseek.ts';
import { reapExpiredRuns } from './runtime/reaper.ts';
import { createScheduler } from './runtime/scheduler.ts';
import { createApp } from './server/index.ts';
import { openDatabase } from './store/migrate.ts';
import { resolveDefaultWorkspace } from './store/settings.ts';

/** 端口常量；SPEC 未指定端口号，取 4310 并由 PORT 覆盖。 */
export const DEFAULT_PORT = 4310;
export const DEFAULT_HOST = '127.0.0.1';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

interface StartupConfig {
  port: number;
  apiKey: string;
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

  const apiKey = envText('DEEPSEEK_API_KEY');
  if (apiKey === undefined) {
    throw new Error('缺少 DEEPSEEK_API_KEY：请在仓库根 .env 中配置后重启');
  }

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

async function main(): Promise<void> {
  const config = readConfig();

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

    const provider = new DeepSeekProvider({
      apiKey: config.apiKey,
      ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
      ...(config.model === undefined ? {} : { model: config.model }),
    });
    const scheduler = createScheduler({
      db,
      provider,
      ctx: { outputDir: join(config.dataDir, 'tool-outputs') },
      reapOnStart: false,
    });
    const app = createApp({
      db,
      scheduler,
      mainAi: { provider },
    });

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
