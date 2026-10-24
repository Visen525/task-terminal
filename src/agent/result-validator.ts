/**
 * 执行内核 · submit_result 专用结构校验器（SPEC §4.5 不变量 5 / M3-03）
 *
 * 约束以常量硬编码在代码里（不在运行期读 schemas/result.schema.json）：
 *   - 校验发生在每个任务的收尾路径上，不应依赖进程 cwd 或打包后的文件布局；
 *   - 不引 zod、不写通用 JSON Schema 引擎，只校验本契约的固定形状；
 *   - 防漂移由验收脚本负责：scripts/verify/m3.test.ts 解析 schema 文件，
 *     逐项断言 required / kind 枚举 / 上限数值与 RESULT_CONSTRAINTS 一致。
 *
 * 校验失败返回中文错误列表，由 loop 作为 tool 结果回喂模型修正。
 */
import type { JsonValue, ToolSpec } from '../core/types.ts';

/** artifacts.kind 的合法取值（与 schemas/result.schema.json 和 SPEC §4.2 一致）。 */
export const RESULT_KINDS = ['file', 'note', 'dataset', 'patch'] as const;
export type ArtifactKind = (typeof RESULT_KINDS)[number];

/** 与 schemas/result.schema.json 一一对应的硬编码约束。 */
export const RESULT_CONSTRAINTS = {
  required: ['summary', 'findings', 'artifacts'],
  additionalProperties: false,
  summary: { minLength: 1, maxLength: 4000 },
  findings: {
    maxItems: 50,
    item: { minLength: 1, maxLength: 1000 },
  },
  artifacts: {
    maxItems: 20,
    required: ['kind', 'title', 'summary'],
    additionalProperties: false,
    kinds: RESULT_KINDS,
    title: { minLength: 1, maxLength: 200 },
    path: { minLength: 1, maxLength: 500 },
    summary: { minLength: 1, maxLength: 2000 },
    tags: {
      maxItems: 10,
      item: { minLength: 1, maxLength: 40 },
    },
  },
} as const;

export interface SubmitArtifact {
  kind: ArtifactKind;
  title: string;
  path?: string;
  summary: string;
  tags?: string[];
}

/** 通过校验后写入 tasks.result_json / task.completed 的完整对象。 */
export interface SubmitResult {
  summary: string;
  findings: string[];
  artifacts: SubmitArtifact[];
}

export type SubmitValidationResult =
  | { ok: true; errors: []; value: SubmitResult }
  | { ok: false; errors: string[] };

/** submit_result 的 ToolSpec；直接由上面的约束生成，避免与校验逻辑漂移。 */
export const SUBMIT_RESULT_SPEC: ToolSpec = {
  name: 'submit_result',
  description:
    '提交任务的结构化结果。必须作为执行结束前的最后一次工具调用；参数必须通过 result schema 校验。做不到时也要调用，并在 summary 里说明原因。',
  parameters: {
    type: 'object',
    required: [...RESULT_CONSTRAINTS.required],
    additionalProperties: false,
    properties: {
      summary: {
        type: 'string',
        minLength: RESULT_CONSTRAINTS.summary.minLength,
        maxLength: RESULT_CONSTRAINTS.summary.maxLength,
        description: '执行总结；做不到时说明原因。',
      },
      findings: {
        type: 'array',
        maxItems: RESULT_CONSTRAINTS.findings.maxItems,
        items: {
          type: 'string',
          minLength: RESULT_CONSTRAINTS.findings.item.minLength,
          maxLength: RESULT_CONSTRAINTS.findings.item.maxLength,
        },
        description: '关键结论列表，每条一句话。',
      },
      artifacts: {
        type: 'array',
        maxItems: RESULT_CONSTRAINTS.artifacts.maxItems,
        items: {
          type: 'object',
          required: [...RESULT_CONSTRAINTS.artifacts.required],
          additionalProperties: false,
          properties: {
            kind: {
              type: 'string',
              enum: [...RESULT_CONSTRAINTS.artifacts.kinds],
            },
            title: {
              type: 'string',
              minLength: RESULT_CONSTRAINTS.artifacts.title.minLength,
              maxLength: RESULT_CONSTRAINTS.artifacts.title.maxLength,
            },
            path: {
              type: 'string',
              minLength: RESULT_CONSTRAINTS.artifacts.path.minLength,
              maxLength: RESULT_CONSTRAINTS.artifacts.path.maxLength,
            },
            summary: {
              type: 'string',
              minLength: RESULT_CONSTRAINTS.artifacts.summary.minLength,
              maxLength: RESULT_CONSTRAINTS.artifacts.summary.maxLength,
            },
            tags: {
              type: 'array',
              maxItems: RESULT_CONSTRAINTS.artifacts.tags.maxItems,
              items: {
                type: 'string',
                minLength: RESULT_CONSTRAINTS.artifacts.tags.item.minLength,
                maxLength: RESULT_CONSTRAINTS.artifacts.tags.item.maxLength,
              },
            },
          },
        },
        description: '产物列表；没有产物时传空数组。',
      },
    },
  },
};

// ── 校验实现 ─────────────────────────────────────────────────────

type JsonRecord = Record<string, unknown>;

interface StringRule {
  minLength: number;
  maxLength: number;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function display(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === undefined) return 'undefined';
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return String(value);
    return text.length > 80 ? `${text.slice(0, 79)}…` : text;
  } catch {
    return typeof value;
  }
}

function joinPath(parent: string, key: string | number): string {
  if (typeof key === 'number') return `${parent}[${key}]`;
  return parent.length === 0 ? key : `${parent}.${key}`;
}

function checkUnknownKeys(
  record: JsonRecord,
  allowed: readonly string[],
  path: string,
  errors: string[],
): void {
  const allowedSet = new Set<string>(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) {
      errors.push(`${joinPath(path, key)} 是不允许的字段`);
    }
  }
}

function checkRequired(
  record: JsonRecord,
  required: readonly string[],
  path: string,
  errors: string[],
): void {
  for (const key of required) {
    if (record[key] === undefined) {
      errors.push(`${joinPath(path, key)} 是必填字段，但缺失了`);
    }
  }
}

function checkString(
  record: JsonRecord,
  key: string,
  rule: StringRule,
  path: string,
  errors: string[],
): void {
  const value = record[key];
  // 缺失字段由 checkRequired 统一报告，这里不重复。
  if (value === undefined) return;
  const field = joinPath(path, key);
  if (typeof value !== 'string') {
    errors.push(`${field} 必须是字符串（当前 ${display(value)}）`);
    return;
  }
  checkStringValue(value, rule, field, errors);
}

function checkStringValue(
  value: unknown,
  rule: StringRule,
  field: string,
  errors: string[],
): boolean {
  if (typeof value !== 'string') {
    errors.push(`${field} 必须是字符串（当前 ${display(value)}）`);
    return false;
  }
  if (value.length < rule.minLength) {
    errors.push(
      rule.minLength === 1 ? `${field} 不能为空` : `${field} 长度不能少于 ${rule.minLength} 个字符`,
    );
    return false;
  }
  if (value.length > rule.maxLength) {
    errors.push(`${field} 长度不能超过 ${rule.maxLength} 个字符（当前 ${value.length}）`);
    return false;
  }
  return true;
}

function checkArray(
  record: JsonRecord,
  key: string,
  maxItems: number,
  path: string,
  errors: string[],
): unknown[] | null {
  const value = record[key];
  const field = joinPath(path, key);
  // 缺失字段由 checkRequired 统一报告，这里不重复。
  if (value === undefined) return null;
  if (!Array.isArray(value)) {
    errors.push(`${field} 必须是数组（当前 ${display(value)}）`);
    return null;
  }
  if (value.length > maxItems) {
    errors.push(`${field} 最多 ${maxItems} 项（当前 ${value.length} 项）`);
  }
  return value;
}

function checkStringArray(
  record: JsonRecord,
  key: string,
  maxItems: number,
  itemRule: StringRule,
  path: string,
  errors: string[],
): void {
  const value = checkArray(record, key, maxItems, path, errors);
  if (value === null) return;
  const field = joinPath(path, key);
  for (let index = 0; index < value.length; index += 1) {
    checkStringValue(value[index], itemRule, joinPath(field, index), errors);
  }
}

/**
 * 校验 submit_result 的参数。
 * 空对象、多余字段、类型错误、越界枚举、超长文本都会返回可读的中文错误。
 */
export function validateSubmitResult(input: unknown): SubmitValidationResult {
  if (!isRecord(input)) {
    return { ok: false, errors: [`submit_result 参数必须是 JSON 对象（当前 ${display(input)}）`] };
  }

  const errors: string[] = [];
  const root = RESULT_CONSTRAINTS;

  checkUnknownKeys(input, root.required, '', errors);
  checkRequired(input, root.required, '', errors);
  checkString(input, 'summary', root.summary, '', errors);
  checkStringArray(input, 'findings', root.findings.maxItems, root.findings.item, '', errors);

  const artifacts = checkArray(input, 'artifacts', root.artifacts.maxItems, '', errors);
  if (artifacts !== null) {
    // additionalProperties:false 的允许集合 = 必填字段 + 可选 path/tags。
    const allowedArtifactKeys = [...root.artifacts.required, 'path', 'tags'];
    for (let index = 0; index < artifacts.length; index += 1) {
      const item = artifacts[index];
      const field = `artifacts[${index}]`;
      if (!isRecord(item)) {
        errors.push(`${field} 必须是对象（当前 ${display(item)}）`);
        continue;
      }
      checkUnknownKeys(item, allowedArtifactKeys, field, errors);
      checkRequired(item, root.artifacts.required, field, errors);

      if (item.kind !== undefined) {
        const kinds: readonly string[] = root.artifacts.kinds;
        if (typeof item.kind !== 'string' || !kinds.includes(item.kind)) {
          errors.push(
            `${field}.kind 必须是 ${kinds.join(' / ')} 之一（当前 ${display(item.kind)}）`,
          );
        }
      }

      checkString(item, 'title', root.artifacts.title, field, errors);
      checkString(item, 'path', root.artifacts.path, field, errors);
      checkString(item, 'summary', root.artifacts.summary, field, errors);
      checkStringArray(item, 'tags', root.artifacts.tags.maxItems, root.artifacts.tags.item, field, errors);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, errors: [], value: buildValue(input) };
}

function buildValue(input: JsonRecord): SubmitResult {
  const findings = (input.findings as unknown[]).map((item) => item as string);
  const artifacts = (input.artifacts as unknown[]).map((item) => {
    const record = item as JsonRecord;
    const artifact: SubmitArtifact = {
      kind: record.kind as ArtifactKind,
      title: record.title as string,
      summary: record.summary as string,
    };
    if (typeof record.path === 'string') artifact.path = record.path;
    if (Array.isArray(record.tags)) artifact.tags = record.tags as string[];
    return artifact;
  });
  return {
    summary: input.summary as string,
    findings,
    artifacts,
  };
}

/** 把通过校验的结果转成事件 payload 可接受的 JSON 值。 */
export function toResultJsonValue(value: SubmitResult): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
