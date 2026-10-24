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

/** 子代理在模型参数之外可调的执行上限（SPEC §10 M11-02）。 */
export interface SubagentSettings extends RoleModelSettings {
  /** 任务级 token 预算；0 = 不限（默认）。日预算仍是全局护栏。 */
  budgetTokens: number;
  /** 单次任务的模型步数上限。 */
  maxSteps: number;
  /** 单次任务的墙钟上限（分钟）。 */
  wallMinutes: number;
}

/** API Key 的来源：界面写入（优先）或 .env / process.env 回退。 */
export type ApiKeySource = 'settings' | 'env';

/**
 * 主线滚动摘要（M12-02）。
 *
 * `upToSeq` 是已并入摘要的最后一条主线消息 seq（总是某个 assistant 轮末），
 * 生成/读取摘要时都以它为边界，保证不会把同一轮重复摘要。
 */
export interface MainConversationSummary {
  text: string;
  upToSeq: number;
  updatedAt: number;
}

export interface AppSettings {
  workspaceDir: string | null;
  /**
   * 主线系统提示词（M10-05）。null = 使用 main-loop 的内置 MAIN_SYSTEM_PROMPT；
   * 非 null 时必须是校验通过的 1–8000 字符文本。
   */
  mainSystemPrompt: string | null;
  main: RoleModelSettings;
  subagent: SubagentSettings;
  mainTaskDefaultPermission: PermissionMode;
  subagentPermissionCap: PermissionMode;
  dailyBudgetTokens: number;
  /**
   * 界面配置的 DeepSeek API Key（M12-01）。null = 回退 env。
   *
   * 该字段被刻意设为不可枚举：JSON.stringify(settings) 永远不含明文，
   * GET /settings / 日志/错误消息因此不可能意外带出 key；落库由
   * serializeSettings() 显式拼装，仍会把 key 写进 app_settings。
   */
  apiKey: string | null;
  /**
   * 12 轮窗口外的旧主对话压缩摘要（M12-02）。null = 尚未生成，
   * 上下文仍只用「[已省略 N 轮更早对话]」标记。
   */
  mainConversationSummary: MainConversationSummary | null;
  /** 以下三项是读时派生的视图字段，不落库，供 GET /settings 与界面使用。 */
  hasApiKey: boolean;
  apiKeyTail: string | null;
  apiKeySource: ApiKeySource | null;
}

/** 设置写入的局部补丁；未出现的字段保持当前值。 */
export interface SettingsPatch {
  workspaceDir?: string | null;
  mainSystemPrompt?: string | null;
  main?: Partial<RoleModelSettings>;
  subagent?: Partial<SubagentSettings>;
  mainTaskDefaultPermission?: PermissionMode;
  subagentPermissionCap?: PermissionMode;
  dailyBudgetTokens?: number;
  apiKey?: string | null;
  /** 内部字段（M12-02）；随 GET /settings 返回，允许客户端整份回写。 */
  mainConversationSummary?: MainConversationSummary | null;
}

export const SETTINGS_ROW_KEY = 'app';

/** SPEC §10 M10-01：主/子代理默认都 deepseek-chat、思考关闭、温度/topP 1.0。 */
export const DEFAULT_SETTINGS: AppSettings = {
  workspaceDir: null,
  mainSystemPrompt: null,
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
    budgetTokens: 0,
    maxSteps: 120,
    wallMinutes: 60,
  },
  mainTaskDefaultPermission: 'workspace-write',
  subagentPermissionCap: 'workspace-write',
  dailyBudgetTokens: 2_000_000,
  apiKey: null,
  mainConversationSummary: null,
  hasApiKey: false,
  apiKeyTail: null,
  apiKeySource: null,
};
// M12-01 安全红线：默认值里的 apiKey 也不可枚举，避免任何通用序列化带出。
hideApiKey(DEFAULT_SETTINGS);

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ROLE_KEYS = ['main', 'subagent'] as const;
const TOP_LEVEL_KEYS = new Set([
  'workspaceDir',
  'mainSystemPrompt',
  'main',
  'subagent',
  'mainTaskDefaultPermission',
  'subagentPermissionCap',
  'dailyBudgetTokens',
  'apiKey',
  'mainConversationSummary',
]);
/** GET /settings 的派生字段；客户端把整份响应 PUT 回来时忽略，不落库。 */
const DERIVED_KEYS = new Set(['hasApiKey', 'apiKeyTail', 'apiKeySource']);
const ROLE_FIELDS = new Set([
  'model',
  'thinkingLevel',
  'temperature',
  'topP',
  'maxTokens',
]);
const SUBAGENT_FIELDS = new Set([
  ...ROLE_FIELDS,
  'budgetTokens',
  'maxSteps',
  'wallMinutes',
]);

const MODEL_MAX_CHARS = 60;
const MAIN_SYSTEM_PROMPT_MAX_CHARS = 8000;
const MAX_TOKENS_MIN = 256;
const MAX_TOKENS_MAX = 8192;
const DAILY_BUDGET_MIN = 50_000;
const SUBAGENT_BUDGET_MIN = 0;
const SUBAGENT_BUDGET_MAX = 2_000_000;
const SUBAGENT_MAX_STEPS_MIN = 1;
const SUBAGENT_MAX_STEPS_MAX = 500;
const SUBAGENT_WALL_MINUTES_MIN = 1;
const SUBAGENT_WALL_MINUTES_MAX = 240;
const API_KEY_MIN_CHARS = 8;
const API_KEY_MAX_CHARS = 200;
/** M12-02：摘要正文上限按 Unicode 码点计，与 conversation-summary 的截断一致。 */
const SUMMARY_MAX_CHARS = 2000;
const SUMMARY_FIELDS = new Set(['text', 'upToSeq', 'updatedAt']);

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

/** 当前 env 中的 key；空白视同未配置。每次调用都重新读，测试可注入。 */
function readEnvApiKey(): string | null {
  const value = process.env.DEEPSEEK_API_KEY;
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** apiKey 不可枚举：任何 JSON 序列化（GET /settings、日志）都不会带出明文。 */
function hideApiKey(settings: AppSettings): AppSettings {
  Object.defineProperty(settings, 'apiKey', {
    value: settings.apiKey,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return settings;
}

/** 由当前生效 key 派生 hasApiKey / 尾号 / 来源；不修改 apiKey 本身。 */
function applyApiKeyView(settings: AppSettings): void {
  const stored = settings.apiKey;
  const envKey = readEnvApiKey();
  const effective = stored ?? envKey;
  settings.hasApiKey = effective !== null;
  settings.apiKeyTail = effective === null ? null : effective.slice(-4);
  settings.apiKeySource =
    stored !== null ? 'settings' : envKey !== null ? 'env' : null;
}

function cloneSettings(settings: AppSettings): AppSettings {
  return hideApiKey({
    workspaceDir: settings.workspaceDir,
    mainSystemPrompt: settings.mainSystemPrompt,
    main: { ...settings.main },
    subagent: { ...settings.subagent },
    mainTaskDefaultPermission: settings.mainTaskDefaultPermission,
    subagentPermissionCap: settings.subagentPermissionCap,
    dailyBudgetTokens: settings.dailyBudgetTokens,
    apiKey: settings.apiKey,
    mainConversationSummary:
      settings.mainConversationSummary === null
        ? null
        : { ...settings.mainConversationSummary },
    hasApiKey: settings.hasApiKey,
    apiKeyTail: settings.apiKeyTail,
    apiKeySource: settings.apiKeySource,
  });
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
    if (DERIVED_KEYS.has(key)) continue;
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

  if ('apiKey' in raw) {
    const value = raw.apiKey;
    if (value === null) {
      patch.apiKey = null;
    } else if (typeof value !== 'string') {
      errors.push('apiKey 必须是字符串或 null');
    } else {
      // 允许用户粘贴带首尾空白的内容；落库前归一化，内部空白一律拒绝。
      const key = value.trim();
      if (key.length === 0) {
        errors.push('apiKey 给值时不能为空');
      } else if (key.length < API_KEY_MIN_CHARS || key.length > API_KEY_MAX_CHARS) {
        errors.push(
          `apiKey 长度必须在 ${API_KEY_MIN_CHARS} 到 ${API_KEY_MAX_CHARS} 个字符之间`,
        );
      } else if (/\s/u.test(key)) {
        errors.push('apiKey 不能包含空白字符');
      } else {
        patch.apiKey = key;
      }
    }
  }

  if ('mainConversationSummary' in raw) {
    const value = raw.mainConversationSummary;
    if (value === null) {
      patch.mainConversationSummary = null;
    } else if (!isRecord(value)) {
      errors.push('mainConversationSummary 必须是对象或 null');
    } else {
      for (const field of Object.keys(value)) {
        if (!SUMMARY_FIELDS.has(field)) {
          errors.push(`mainConversationSummary.${field} 不是可配置字段`);
        }
      }
      const text = value.text;
      const upToSeq = value.upToSeq;
      const updatedAt = value.updatedAt;
      if (typeof text !== 'string' || text.trim().length === 0) {
        errors.push('mainConversationSummary.text 必须是非空字符串');
      } else if ([...text].length > SUMMARY_MAX_CHARS) {
        errors.push(
          `mainConversationSummary.text 长度不能超过 ${SUMMARY_MAX_CHARS} 个字符`,
        );
      } else if (
        typeof upToSeq !== 'number' ||
        !Number.isInteger(upToSeq) ||
        upToSeq < 0
      ) {
        errors.push('mainConversationSummary.upToSeq 必须是非负整数');
      } else if (
        typeof updatedAt !== 'number' ||
        !Number.isInteger(updatedAt) ||
        updatedAt < 0
      ) {
        errors.push('mainConversationSummary.updatedAt 必须是非负整数');
      } else {
        patch.mainConversationSummary = { text, upToSeq, updatedAt };
      }
    }
  }

  if ('mainSystemPrompt' in raw) {
    const value = raw.mainSystemPrompt;
    if (value === null) {
      patch.mainSystemPrompt = null;
    } else if (typeof value !== 'string') {
      errors.push('mainSystemPrompt 必须是字符串或 null');
    } else if (value.trim().length === 0) {
      // 清空后恢复内置默认由前端提交 null 表达；空串本身不是合法提示词。
      errors.push('mainSystemPrompt 给值时不能为空');
    } else if (value.length > MAIN_SYSTEM_PROMPT_MAX_CHARS) {
      errors.push(
        `mainSystemPrompt 长度不能超过 ${MAIN_SYSTEM_PROMPT_MAX_CHARS} 个字符`,
      );
    } else {
      patch.mainSystemPrompt = value;
    }
  }

  for (const role of ROLE_KEYS) {
    if (!(role in raw)) continue;
    const value = raw[role];
    if (!isRecord(value)) {
      errors.push(`${role} 必须是 JSON 对象`);
      continue;
    }

    const rolePatch: Partial<SubagentSettings> = {};
    const allowedFields = role === 'main' ? ROLE_FIELDS : SUBAGENT_FIELDS;
    for (const field of Object.keys(value)) {
      if (!allowedFields.has(field)) {
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

    if (role === 'subagent') {
      if ('budgetTokens' in value) {
        const budgetTokens = parseBoundedNumber(
          value.budgetTokens,
          'subagent.budgetTokens',
          SUBAGENT_BUDGET_MIN,
          SUBAGENT_BUDGET_MAX,
          true,
          errors,
        );
        if (budgetTokens !== undefined) rolePatch.budgetTokens = budgetTokens;
      }

      if ('maxSteps' in value) {
        const maxSteps = parseBoundedNumber(
          value.maxSteps,
          'subagent.maxSteps',
          SUBAGENT_MAX_STEPS_MIN,
          SUBAGENT_MAX_STEPS_MAX,
          true,
          errors,
        );
        if (maxSteps !== undefined) rolePatch.maxSteps = maxSteps;
      }

      if ('wallMinutes' in value) {
        const wallMinutes = parseBoundedNumber(
          value.wallMinutes,
          'subagent.wallMinutes',
          SUBAGENT_WALL_MINUTES_MIN,
          SUBAGENT_WALL_MINUTES_MAX,
          true,
          errors,
        );
        if (wallMinutes !== undefined) rolePatch.wallMinutes = wallMinutes;
      }
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
  if ('mainSystemPrompt' in patch) {
    merged.mainSystemPrompt = patch.mainSystemPrompt ?? null;
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
  if ('apiKey' in patch) {
    merged.apiKey = patch.apiKey ?? null;
  }
  if ('mainConversationSummary' in patch) {
    const summary = patch.mainConversationSummary;
    merged.mainConversationSummary = summary === undefined || summary === null
      ? null
      : { ...summary };
  }
  // 派生字段始终由「当前 settings + env」重新计算，绝不信任落库值。
  applyApiKeyView(merged);
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
  if (row === undefined) {
    const defaults = cloneSettings(DEFAULT_SETTINGS);
    applyApiKeyView(defaults);
    return defaults;
  }

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
 * 落库序列化显式列出字段：apiKey 在内存里不可枚举（防日志/GET 泄露），
 * 但必须写进 app_settings；派生视图字段不落库。
 */
function serializeSettings(settings: AppSettings): string {
  return JSON.stringify({
    workspaceDir: settings.workspaceDir,
    mainSystemPrompt: settings.mainSystemPrompt,
    main: settings.main,
    subagent: settings.subagent,
    mainTaskDefaultPermission: settings.mainTaskDefaultPermission,
    subagentPermissionCap: settings.subagentPermissionCap,
    dailyBudgetTokens: settings.dailyBudgetTokens,
    apiKey: settings.apiKey,
    mainConversationSummary: settings.mainConversationSummary,
  });
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
  ).run(SETTINGS_ROW_KEY, serializeSettings(merged), now);
  return merged;
}

/**
 * 当前生效 key：settings.apiKey > env DEEPSEEK_API_KEY > null（M12-01）。
 * 每次调用都重新读 DB/env，因此设置页保存后下一轮对话/下一次 tick 立即生效。
 */
export function getEffectiveApiKey(db: DatabaseSync): string | null {
  const stored = getSettings(db).apiKey;
  if (stored !== null && stored.length > 0) return stored;
  return readEnvApiKey();
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
