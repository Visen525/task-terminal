/**
 * 应用设置（SPEC §10 M10-01）。
 *
 * 单行持久化：`app_settings` 只用 key='app' 一行存整份 JSON，读时与
 * DEFAULT_SETTINGS 深合并，写时整行覆盖。这样新增字段时旧库不会缺键，
 * 也不需要为每个设置项建列。
 *
 * 边界：本文件只管设置的读写、校验与默认工作区解析，不调 LLM、不写事件。
 * 时间戳由调用方注入（默认 Date.now），便于验收脚本断言 updated_at。
 */
import { realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { ContractError, ERROR_CODES } from '../core/errors.ts';
import { PERMISSION_MODES, type PermissionMode } from '../core/types.ts';

export const THINKING_LEVELS = ['off', 'low', 'medium', 'high'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface RoleModelSettings {
  model: string;
  thinkingLevel: ThinkingLevel;
  temperature: number;
  topP: number;
  maxTokens: number;
}

export interface AppSettings {
  workspaceDir: string | null;
  main: RoleModelSettings;
  subagent: RoleModelSettings;
  mainTaskDefaultPermission: PermissionMode;
  subagentPermissionCap: PermissionMode;
  dailyBudgetTokens: number;
}

/** 设置写入的局部补丁；未出现的字段保持当前值。 */
export interface SettingsPatch {
  workspaceDir?: string | null;
  main?: Partial<RoleModelSettings>;
  subagent?: Partial<RoleModelSettings>;
  mainTaskDefaultPermission?: PermissionMode;
  subagentPermissionCap?: PermissionMode;
  dailyBudgetTokens?: number;
}

export const SETTINGS_ROW_KEY = 'app';

/** SPEC §10 M10-01：主/子代理默认都 deepseek-chat、思考关闭、温度/topP 1.0。 */
export const DEFAULT_SETTINGS: AppSettings = {
  workspaceDir: null,
  main: {
    model: 'deepseek-chat',
    thinkingLevel: 'off',
    temperature: 1.0,
    topP: 1.0,
    maxTokens: 4096,
  },
  subagent: {
    model: 'deepseek-chat',
    thinkingLevel: 'off',
    temperature: 1.0,
    topP: 1.0,
    maxTokens: 4096,
  },
  mainTaskDefaultPermission: 'workspace-write',
  subagentPermissionCap: 'workspace-write',
  dailyBudgetTokens: 2_000_000,
};

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ROLE_KEYS = ['main', 'subagent'] as const;
const TOP_LEVEL_KEYS = new Set([
  'workspaceDir',
  'main',
  'subagent',
  'mainTaskDefaultPermission',
  'subagentPermissionCap',
  'dailyBudgetTokens',
]);
const ROLE_FIELDS = new Set([
  'model',
  'thinkingLevel',
  'temperature',
  'topP',
  'maxTokens',
]);

const MODEL_MAX_CHARS = 60;
const MAX_TOKENS_MIN = 256;
const MAX_TOKENS_MAX = 8192;
const DAILY_BUDGET_MIN = 50_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value);
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return (
    typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value)
  );
}

function cloneSettings(settings: AppSettings): AppSettings {
  return {
    workspaceDir: settings.workspaceDir,
    main: { ...settings.main },
    subagent: { ...settings.subagent },
    mainTaskDefaultPermission: settings.mainTaskDefaultPermission,
    subagentPermissionCap: settings.subagentPermissionCap,
    dailyBudgetTokens: settings.dailyBudgetTokens,
  };
}

/**
 * 结构校验（不查 workspaceDir 是否真实存在）。返回只含已出现字段的补丁。
 * 错误统一累加到 errors，调用方决定是 E_INVALID_ARGUMENT 还是 E_INTERNAL。
 */
function parseSettingsPatch(raw: unknown, errors: string[]): SettingsPatch {
  if (!isRecord(raw)) {
    errors.push('settings 必须是 JSON 对象');
    return {};
  }

  const patch: SettingsPatch = {};

  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      errors.push(`${key} 不是可配置字段`);
    }
  }

  if ('workspaceDir' in raw) {
    const value = raw.workspaceDir;
    if (value === null) {
      patch.workspaceDir = null;
    } else if (typeof value !== 'string') {
      errors.push('workspaceDir 必须是字符串或 null');
    } else if (value.trim().length === 0) {
      errors.push('workspaceDir 必须是非空路径或 null');
    } else {
      patch.workspaceDir = value.trim();
    }
  }

  for (const role of ROLE_KEYS) {
    if (!(role in raw)) continue;
    const value = raw[role];
    if (!isRecord(value)) {
      errors.push(`${role} 必须是 JSON 对象`);
      continue;
    }

    const rolePatch: Partial<RoleModelSettings> = {};
    for (const field of Object.keys(value)) {
      if (!ROLE_FIELDS.has(field)) {
        errors.push(`${role}.${field} 不是可配置字段`);
      }
    }

    if ('model' in value) {
      const model = value.model;
      if (typeof model !== 'string' || model.trim().length === 0) {
        errors.push(`${role}.model 必须是非空字符串`);
      } else if (model.trim().length > MODEL_MAX_CHARS) {
        errors.push(`${role}.model 长度不能超过 ${MODEL_MAX_CHARS} 个字符`);
      } else {
        rolePatch.model = model.trim();
      }
    }

    if ('thinkingLevel' in value) {
      if (!isThinkingLevel(value.thinkingLevel)) {
        errors.push(
          `${role}.thinkingLevel 必须是 ${THINKING_LEVELS.join('|')} 之一`,
        );
      } else {
        rolePatch.thinkingLevel = value.thinkingLevel;
      }
    }

    if ('temperature' in value) {
      const temperature = parseBoundedNumber(
        value.temperature,
        `${role}.temperature`,
        0,
        2,
        false,
        errors,
      );
      if (temperature !== undefined) rolePatch.temperature = temperature;
    }

    if ('topP' in value) {
      const topP = parseBoundedNumber(value.topP, `${role}.topP`, 0, 1, false, errors);
      if (topP !== undefined) rolePatch.topP = topP;
    }

    if ('maxTokens' in value) {
      const maxTokens = parseBoundedNumber(
        value.maxTokens,
        `${role}.maxTokens`,
        MAX_TOKENS_MIN,
        MAX_TOKENS_MAX,
        true,
        errors,
      );
      if (maxTokens !== undefined) rolePatch.maxTokens = maxTokens;
    }

    if (role === 'main') patch.main = rolePatch;
    else patch.subagent = rolePatch;
  }

  if ('mainTaskDefaultPermission' in raw) {
    if (!isPermissionMode(raw.mainTaskDefaultPermission)) {
      errors.push(
        `mainTaskDefaultPermission 必须是 ${PERMISSION_MODES.join('|')} 之一`,
      );
    } else {
      patch.mainTaskDefaultPermission = raw.mainTaskDefaultPermission;
    }
  }

  if ('subagentPermissionCap' in raw) {
    if (!isPermissionMode(raw.subagentPermissionCap)) {
      errors.push(`subagentPermissionCap 必须是 ${PERMISSION_MODES.join('|')} 之一`);
    } else {
      patch.subagentPermissionCap = raw.subagentPermissionCap;
    }
  }

  if ('dailyBudgetTokens' in raw) {
    const dailyBudgetTokens = parseBoundedNumber(
      raw.dailyBudgetTokens,
      'dailyBudgetTokens',
      DAILY_BUDGET_MIN,
      Number.MAX_SAFE_INTEGER,
      true,
      errors,
    );
    if (dailyBudgetTokens !== undefined) patch.dailyBudgetTokens = dailyBudgetTokens;
  }

  return patch;
}

function parseBoundedNumber(
  raw: unknown,
  field: string,
  min: number,
  max: number,
  integer: boolean,
  errors: string[],
): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    errors.push(`${field} 必须是数字`);
    return undefined;
  }
  if (integer && !Number.isInteger(raw)) {
    errors.push(`${field} 必须是整数`);
    return undefined;
  }
  if (raw < min || raw > max) {
    errors.push(`${field} 必须在 ${min} 到 ${max} 之间`);
    return undefined;
  }
  return raw;
}

function mergeSettings(base: AppSettings, patch: SettingsPatch): AppSettings {
  const merged = cloneSettings(base);
  if ('workspaceDir' in patch) {
    merged.workspaceDir = patch.workspaceDir ?? null;
  }
  if (patch.main !== undefined) {
    merged.main = { ...merged.main, ...patch.main };
  }
  if (patch.subagent !== undefined) {
    merged.subagent = { ...merged.subagent, ...patch.subagent };
  }
  if (patch.mainTaskDefaultPermission !== undefined) {
    merged.mainTaskDefaultPermission = patch.mainTaskDefaultPermission;
  }
  if (patch.subagentPermissionCap !== undefined) {
    merged.subagentPermissionCap = patch.subagentPermissionCap;
  }
  if (patch.dailyBudgetTokens !== undefined) {
    merged.dailyBudgetTokens = patch.dailyBudgetTokens;
  }
  return merged;
}

/**
 * 校验 PUT /settings 的局部补丁。
 *
 * - 枚举/数值范围/模型长度逐字段报错，错误信息带字段路径；
 * - workspaceDir 非 null 时 resolve 到 fs.realpath，且必须是已存在的目录；
 * - 返回归一化后的补丁（workspaceDir 为真实绝对路径）。
 */
export function validateSettingsInput(partial: unknown): SettingsPatch {
  const errors: string[] = [];
  const patch = parseSettingsPatch(partial, errors);

  if (typeof patch.workspaceDir === 'string') {
    try {
      const resolved = realpathSync(patch.workspaceDir);
      if (!statSync(resolved).isDirectory()) {
        errors.push('workspaceDir 不存在或不是目录');
      } else {
        patch.workspaceDir = resolved;
      }
    } catch {
      // 不回显用户给的路径，避免把个人目录带进错误响应/日志。
      errors.push('workspaceDir 不存在或不是目录');
    }
  }

  if (errors.length > 0) {
    throw new ContractError(ERROR_CODES.E_INVALID_ARGUMENT, errors.join('；'));
  }
  return patch;
}

/**
 * 读取设置：无记录返回默认值；坏 JSON / 坏结构抛 E_INTERNAL，不静默兜底。
 * 读出的局部数据也会与默认值深合并，兼容未来/手工写入的缺字段行。
 */
export function getSettings(db: DatabaseSync): AppSettings {
  const row = db
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(SETTINGS_ROW_KEY) as unknown as { value?: unknown } | undefined;
  if (row === undefined) return cloneSettings(DEFAULT_SETTINGS);

  let parsed: unknown;
  try {
    parsed = JSON.parse(String(row.value));
  } catch {
    throw new ContractError(
      ERROR_CODES.E_INTERNAL,
      'app_settings 数据损坏：value 不是合法 JSON',
    );
  }

  const errors: string[] = [];
  const patch = parseSettingsPatch(parsed, errors);
  if (errors.length > 0) {
    throw new ContractError(
      ERROR_CODES.E_INTERNAL,
      `app_settings 数据损坏：${errors.join('；')}`,
    );
  }
  return mergeSettings(DEFAULT_SETTINGS, patch);
}

/**
 * 保存设置：校验 → 与当前值深合并 → 整行覆盖 key='app'，updated_at=now。
 * 校验失败不会写库。
 */
export function saveSettings(
  db: DatabaseSync,
  partial: unknown,
  now: number = Date.now(),
): AppSettings {
  const patch = validateSettingsInput(partial);
  const merged = mergeSettings(getSettings(db), patch);
  db.prepare(
    `INSERT INTO app_settings(key, value, updated_at)
     VALUES(?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(SETTINGS_ROW_KEY, JSON.stringify(merged), now);
  return merged;
}

/**
 * 默认工作区解析：settings.workspaceDir > env WORKSPACE_DIR > <repo>/workspace。
 * 不在此处创建目录；装配层负责 mkdir。
 */
export function resolveDefaultWorkspace(db: DatabaseSync): string {
  const stored = getSettings(db).workspaceDir;
  if (stored !== null && stored.trim().length > 0) return stored;

  const fromEnv = process.env.WORKSPACE_DIR;
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv.trim();

  return join(REPO_ROOT, 'workspace');
}
