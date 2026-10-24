/**
 * 长期事实仓储（SPEC §4.2 memory_facts / §7 M5-01）。
 *
 * 写语义：
 *   - 同一 scope + key 的「当前有效」记录（superseded_by IS NULL）若值不同，
 *     旧记录指向新记录（superseded_by），新记录 confidence 默认 0.6；
 *   - 值相同则原地更新 confidence / 来源 / updated_at，不制造重复行。
 * 读语义：
 *   - 只读当前有效记录，按 confidence DESC、updated_at DESC 排序；
 *   - query 对 key/value 做大小写不敏感子串匹配，空 query 返回 topN；
 *   - scope 精确过滤；传 project / project: 时按 project: 前缀过滤项目族。
 *
 * 本模块不写事件：memory.fact_upserted 的编排由主线工具负责。
 */
import type { DatabaseSync } from 'node:sqlite';

import { ContractError, ERROR_CODES } from '../core/errors.ts';
import { newUlid } from './ulid.ts';

export const DEFAULT_FACT_SCOPE = 'global';
export const DEFAULT_FACT_CONFIDENCE = 0.6;
export const DEFAULT_RECALL_LIMIT = 20;

export interface Fact {
  id: string;
  scope: string;
  key: string;
  value: string;
  confidence: number;
  sourceTaskId: string | null;
  /** 由哪几条事件得出；未提供时为 null。 */
  sourceSeqs: number[] | null;
  supersededBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface UpsertFactInput {
  key: string;
  value: string;
  /** 默认 global。 */
  scope?: string;
  /** 新记录默认 0.6；同值更新时缺省保留旧值。 */
  confidence?: number;
  sourceTaskId?: string | null;
  sourceSeqs?: readonly number[] | null;
  /** 可注入时钟；默认 Date.now()。 */
  now?: number;
}

export interface RecallFactsOptions {
  /** 对 key/value 做大小写不敏感子串匹配；空串/省略返回 topN。 */
  query?: string;
  /** 精确 scope；project / project: 表示匹配全部 project: 前缀。 */
  scope?: string;
  /** 默认 DEFAULT_RECALL_LIMIT。 */
  limit?: number;
}

interface FactRow {
  id: string;
  scope: string;
  key: string;
  value: string;
  confidence: number;
  source_task_id: string | null;
  source_seqs: string | null;
  superseded_by: string | null;
  created_at: number;
  updated_at: number;
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_RECALL_LIMIT;
  return Math.max(0, Math.floor(limit));
}

function normalizeConfidence(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return value;
}

/**
 * 把用户输入当成字面量做 LIKE 子串匹配：先转义反斜杠，再转义 % 与 _，
 * 配合 SQL 的 ESCAPE '\'，查询 "100%" 只命中含字面量 "100%" 的事实。
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function parseSourceSeqs(raw: string | null): number[] | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ContractError(
      ERROR_CODES.E_INTERNAL,
      `memory_facts.source_seqs 不是合法 JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((item) => typeof item === 'number' && Number.isSafeInteger(item))
  ) {
    throw new ContractError(
      ERROR_CODES.E_INTERNAL,
      'memory_facts.source_seqs 应为 JSON 整数数组',
    );
  }
  return parsed as number[];
}

function serializeSourceSeqs(value: readonly number[] | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify([...value]);
}

function mapFact(row: FactRow): Fact {
  return {
    id: row.id,
    scope: row.scope,
    key: row.key,
    value: row.value,
    confidence: row.confidence,
    sourceTaskId: row.source_task_id,
    sourceSeqs: parseSourceSeqs(row.source_seqs),
    supersededBy: row.superseded_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 读取单条事实（含已被取代的历史记录）；不存在返回 null。 */
export function getFact(db: DatabaseSync, id: string): Fact | null {
  const row = db.prepare('SELECT * FROM memory_facts WHERE id = ?').get(id) as unknown as
    | FactRow
    | undefined;
  return row ? mapFact(row) : null;
}

function findCurrentFact(
  db: DatabaseSync,
  scope: string,
  key: string,
): FactRow | undefined {
  return db
    .prepare(
      `SELECT * FROM memory_facts
        WHERE scope = ? AND key = ? AND superseded_by IS NULL
        ORDER BY updated_at DESC, created_at DESC, rowid DESC
        LIMIT 1`,
    )
    .get(scope, key) as unknown as FactRow | undefined;
}

function insertFactRow(
  db: DatabaseSync,
  input: UpsertFactInput,
  scope: string,
  now: number,
  confidence: number,
): string {
  const id = `f_${newUlid(now)}`;
  db.prepare(
    `INSERT INTO memory_facts
      (id, scope, key, value, confidence, source_task_id, source_seqs,
       superseded_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    id,
    scope,
    input.key,
    input.value,
    confidence,
    input.sourceTaskId ?? null,
    serializeSourceSeqs(input.sourceSeqs),
    now,
    now,
  );
  return id;
}

/**
 * 写入/更新一条长期事实，返回本次落库后的当前记录。
 *
 * 值不同时在同一事务内「插入新记录 + 旧记录 superseded_by 指向新记录」，
 * 保证 recall 不会读到短暂的双当前行。
 */
export function upsertFact(db: DatabaseSync, input: UpsertFactInput): Fact {
  const scope = input.scope ?? DEFAULT_FACT_SCOPE;
  const now = input.now ?? Date.now();
  const current = findCurrentFact(db, scope, input.key);

  if (current === undefined) {
    const id = insertFactRow(
      db,
      input,
      scope,
      now,
      normalizeConfidence(input.confidence, DEFAULT_FACT_CONFIDENCE),
    );
    const created = getFact(db, id);
    if (created === null) {
      throw new ContractError(ERROR_CODES.E_INTERNAL, `事实插入后读回失败: ${id}`);
    }
    return created;
  }

  if (current.value === input.value) {
    const confidence = normalizeConfidence(input.confidence, current.confidence);
    const sourceTaskId =
      input.sourceTaskId === undefined ? current.source_task_id : input.sourceTaskId;
    const sourceSeqs =
      input.sourceSeqs === undefined
        ? current.source_seqs
        : serializeSourceSeqs(input.sourceSeqs);
    db.prepare(
      `UPDATE memory_facts
          SET confidence = ?, source_task_id = ?, source_seqs = ?, updated_at = ?
        WHERE id = ?`,
    ).run(confidence, sourceTaskId, sourceSeqs, now, current.id);
    const updated = getFact(db, current.id);
    if (updated === null) {
      throw new ContractError(ERROR_CODES.E_INTERNAL, `事实更新后读回失败: ${current.id}`);
    }
    return updated;
  }

  db.exec('BEGIN IMMEDIATE');
  let newId: string;
  try {
    newId = insertFactRow(
      db,
      input,
      scope,
      now,
      normalizeConfidence(input.confidence, DEFAULT_FACT_CONFIDENCE),
    );
    db.prepare(
      'UPDATE memory_facts SET superseded_by = ?, updated_at = ? WHERE id = ?',
    ).run(newId, now, current.id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  const created = getFact(db, newId);
  if (created === null) {
    throw new ContractError(ERROR_CODES.E_INTERNAL, `事实插入后读回失败: ${newId}`);
  }
  return created;
}

/**
 * 检索当前有效事实。
 * query 为空（或省略）时按 confidence + 时间返回 topN；
 * query 对 key/value 做字面量模糊匹配（%、_ 不当通配符）；
 * scope 精确过滤，project / project: 匹配全部项目事实。
 */
export function recallFacts(
  db: DatabaseSync,
  options: RecallFactsOptions = {},
): Fact[] {
  const limit = normalizeLimit(options.limit);
  if (limit === 0) return [];

  const where: string[] = ['superseded_by IS NULL'];
  const params: Array<string | number> = [];
  if (options.scope !== undefined) {
    const scope = options.scope.trim();
    if (scope === 'project' || scope === 'project:') {
      where.push("scope LIKE 'project:%'");
    } else {
      where.push('scope = ?');
      params.push(scope);
    }
  }
  const query = options.query?.trim() ?? '';
  if (query.length > 0) {
    const pattern = `%${escapeLikePattern(query)}%`;
    where.push(
      "(lower(key) LIKE lower(?) ESCAPE '\\' OR lower(value) LIKE lower(?) ESCAPE '\\')",
    );
    params.push(pattern, pattern);
  }

  const rows = db
    .prepare(
      `SELECT * FROM memory_facts
        WHERE ${where.join(' AND ')}
        ORDER BY confidence DESC, updated_at DESC, created_at DESC, rowid DESC
        LIMIT ?`,
    )
    .all(...params, limit) as unknown as FactRow[];
  return rows.map(mapFact);
}
