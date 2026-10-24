/**
 * 设置与目录浏览的 REST 封装（M10-02）。
 *
 * 与 api.ts 一样只走相对路径；字段与后端 `src/store/settings.ts` 的契约保持一致。
 * GET /settings 返回完整设置（workspaceDir 未设置时为 null），PUT 接受局部补丁
 * 并返回合并后的完整设置；/fs/browse 只返回目录名与 enterable，不返回文件。
 */
import type { PermissionMode } from "./api";

export type ThinkingLevel = "off" | "low" | "medium" | "high";

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

export interface SettingsPatch {
  workspaceDir?: string | null;
  main?: Partial<RoleModelSettings>;
  subagent?: Partial<RoleModelSettings>;
  mainTaskDefaultPermission?: PermissionMode;
  subagentPermissionCap?: PermissionMode;
  dailyBudgetTokens?: number;
}

export interface BrowseEntry {
  name: string;
  enterable: boolean;
}

/** GET /fs/browse 的实际响应；total/limit 对前端只用于截断提示。 */
export interface BrowseResult {
  path: string;
  entries: BrowseEntry[];
  truncated: boolean;
  total: number;
  limit: number;
}

export class SettingsHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "SettingsHttpError";
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "low", "medium", "high"];
const PERMISSION_MODES: readonly PermissionMode[] = ["read-only", "workspace-write"];

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}

function isRoleModelSettings(value: unknown): value is RoleModelSettings {
  return (
    isRecord(value) &&
    typeof value.model === "string" &&
    isThinkingLevel(value.thinkingLevel) &&
    isFiniteNumber(value.temperature) &&
    isFiniteNumber(value.topP) &&
    isFiniteNumber(value.maxTokens)
  );
}

function isAppSettings(value: unknown): value is AppSettings {
  return (
    isRecord(value) &&
    (value.workspaceDir === null || typeof value.workspaceDir === "string") &&
    isRoleModelSettings(value.main) &&
    isRoleModelSettings(value.subagent) &&
    isPermissionMode(value.mainTaskDefaultPermission) &&
    isPermissionMode(value.subagentPermissionCap) &&
    isFiniteNumber(value.dailyBudgetTokens)
  );
}

async function readErrorMessage(response: Response): Promise<string> {
  const fallback = `请求失败（HTTP ${response.status}）`;
  const text = await response.text();
  if (text.trim().length === 0) return fallback;
  try {
    const body: unknown = JSON.parse(text);
    if (isRecord(body) && isRecord(body.error) && typeof body.error.message === "string") {
      return body.error.message;
    }
  } catch {
    return text;
  }
  return fallback;
}

async function requestJson(
  path: string,
  options: { method?: "GET" | "PUT"; body?: unknown } = {},
): Promise<unknown> {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: {
      Accept: "application/json",
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  if (!response.ok) {
    throw new SettingsHttpError(response.status, await readErrorMessage(response));
  }
  return (await response.json()) as unknown;
}

/** GET /settings；workspaceDir === null 是首次运行向导的触发条件。 */
export async function getSettings(): Promise<AppSettings> {
  const body = await requestJson("/settings");
  if (!isAppSettings(body)) {
    throw new Error("GET /settings 返回格式不合法");
  }
  return body;
}

/** PUT /settings；后端校验失败返回 400，错误信息带字段路径。 */
export async function putSettings(patch: SettingsPatch): Promise<AppSettings> {
  const body = await requestJson("/settings", { method: "PUT", body: patch });
  if (!isAppSettings(body)) {
    throw new Error("PUT /settings 返回格式不合法");
  }
  return body;
}

/** GET /fs/browse?path=；缺省 path 时由后端选择当前盘根。 */
export async function browseDirectory(path?: string): Promise<BrowseResult> {
  const trimmed = path?.trim() ?? "";
  const query = trimmed.length === 0 ? "" : `?path=${encodeURIComponent(trimmed)}`;
  const body = await requestJson(`/fs/browse${query}`);
  if (!isRecord(body) || typeof body.path !== "string" || !Array.isArray(body.entries)) {
    throw new Error("GET /fs/browse 返回格式不合法");
  }

  const entries: BrowseEntry[] = [];
  for (const rawEntry of body.entries) {
    if (
      !isRecord(rawEntry) ||
      typeof rawEntry.name !== "string" ||
      typeof rawEntry.enterable !== "boolean"
    ) {
      throw new Error("GET /fs/browse 的 entries 格式不合法");
    }
    entries.push({ name: rawEntry.name, enterable: rawEntry.enterable });
  }

  return {
    path: body.path,
    entries,
    truncated: body.truncated === true,
    total: isFiniteNumber(body.total) ? body.total : entries.length,
    limit: isFiniteNumber(body.limit) ? body.limit : entries.length,
  };
}

/**
 * 把 400 的 `error.message`（多个字段用「；」连接）拆成字段错误与兜底错误。
 * 只识别设置页真实存在的字段，避免把任意路径/文本误当字段。
 */
const SETTINGS_FIELD_PATTERN =
  /^(main\.(?:model|thinkingLevel|temperature|topP|maxTokens)|subagent\.(?:model|thinkingLevel|temperature|topP|maxTokens)|workspaceDir|mainTaskDefaultPermission|subagentPermissionCap|dailyBudgetTokens)\b/u;

export interface ParsedSettingsError {
  fieldErrors: Record<string, string>;
  general: string[];
}

export function parseSettingsFieldErrors(message: string): ParsedSettingsError {
  const fieldErrors: Record<string, string> = {};
  const general: string[] = [];
  for (const rawPart of message.split(/[；;\n]/u)) {
    const part = rawPart.trim();
    if (part.length === 0) continue;
    const match = SETTINGS_FIELD_PATTERN.exec(part);
    if (match?.[1] === undefined) {
      general.push(part);
    } else {
      fieldErrors[match[1]] = part;
    }
  }
  return { fieldErrors, general };
}
