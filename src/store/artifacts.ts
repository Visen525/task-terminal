/**
 * 产物仓储（SPEC §7 M1-02）：标题/摘要/标签/发现的写入与 FTS5 同步检索。
 *
 * FTS 同步采用方案 B（应用层双写）：artifacts 主表与 artifact_fts 在同一事务内
 * 更新。所有产物写入必须经过本模块，不能再绕过它直接 INSERT artifacts。
 * FTS 只索引 title / summary / tags / findings 四列，绝不索引产物正文。
 */
import type { DatabaseSync } from 'node:sqlite';

import { ContractError, ERROR_CODES } from '../core/errors.ts';
import { newUlid } from './ulid.ts';

export const ARTIFACT_KINDS = ['file', 'note', 'dataset', 'patch'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const ARTIFACT_TRUST_LEVELS = ['unverified', 'verified', 'failed'] as const;
export type ArtifactTrust = (typeof ARTIFACT_TRUST_LEVELS)[number];

export interface Artifact {
  id: string;
  taskId: string;
  runId: string | null;
  kind: ArtifactKind;
  title: string;
  path: string | null;
  sha256: string | null;
  bytes: number | null;
  summary: string;
  tags: string[];
  findings: string[];
  trust: ArtifactTrust;
  verifiedBy: string | null;
  verifiedAt: number | null;
  createdAt: number;
}

export interface NewArtifactInput {
  taskId: string;
  kind: ArtifactKind;
  title: string;
  summary: string;
  tags?: readonly string[];
  findings?: readonly string[];
  path?: string | null;
  runId?: string | null;
  sha256?: string | null;
  bytes?: number | null;
  trust?: ArtifactTrust;
  verifiedBy?: string | null;
  verifiedAt?: number | null;
  /** 允许调用方指定 ID（批量导入 / 测试用），默认 a_<ulid>。 */
  id?: string;
  /** 覆盖 created_at，默认 Date.now()。 */
  now?: number;
}

/** 更新产物检索字段：字符串等价于只更新 summary。 */
export type ArtifactSummaryPatch =
  | string
  | {
      title?: string;
      summary?: string;
      tags?: readonly string[] | null;
      findings?: readonly string[] | null;
    };

export interface ArtifactSearchHit extends Artifact {
  /** FTS5 bm25（越小越相关）；短查询退化路径下为字段命中分。 */
  score: number;
  /** 命中上下文，命中词用 [] 包裹。 */
  snippet: string;
}

export interface SearchArtifactsOptions {
  query: string;
  limit?: number;
}

interface ArtifactRow {
  rowid: number;
  id: string;
  task_id: string;
  run_id: string | null;
  kind: string;
  title: string;
  path: string | null;
  sha256: string | null;
  bytes: number | null;
  summary: string;
  tags: string | null;
  findings: string | null;
  trust: string;
  verified_by: string | null;
  verified_at: number | null;
  created_at: number;
}

interface ArtifactSearchRow extends ArtifactRow {
  score: number;
  snippet: string;
}

/** trigram 分词器对少于 3 个字符的 MATCH 查询不返回结果。 */
const MIN_TRIGRAM_CHARS = 3;
const DEFAULT_SEARCH_LIMIT = 10;

const ARTIFACT_COLUMNS = `a.id, a.task_id, a.run_id, a.kind, a.title, a.path, a.sha256,
  a.bytes, a.summary, a.tags, a.findings, a.trust, a.verified_by, a.verified_at,
  a.created_at`;

function newArtifactId(): string {
  return `a_${newUlid()}`;
}

function parseStringArray(value: string | null, column: string): string[] {
  if (value === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new ContractError(
      ERROR_CODES.E_INTERNAL,
      `产物列 ${column} 不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new ContractError(ERROR_CODES.E_INTERNAL, `产物列 ${column} 应为 JSON 字符串数组`);
  }
  return parsed;
}

function serializeStringArray(value: readonly string[] | null | undefined): string {
  return JSON.stringify([...(value ?? [])]);
}

function mapArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    taskId: row.task_id,
    runId: row.run_id,
    kind: row.kind as ArtifactKind,
    title: row.title,
    path: row.path,
    sha256: row.sha256,
    bytes: row.bytes,
    summary: row.summary,
    tags: parseStringArray(row.tags, 'tags'),
    findings: parseStringArray(row.findings, 'findings'),
    trust: row.trust as ArtifactTrust,
    verifiedBy: row.verified_by,
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
  };
}

function normalizeLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_SEARCH_LIMIT;
  const value = Math.floor(limit);
  if (value < 0) return 0;
  return value;
}

function countChars(value: string): number {
  return [...value].length;
}

function splitQuery(query: string): string[] {
  return query.trim().split(/\s+/u).filter((token) => token.length > 0);
}

function mapSearchRow(row: ArtifactSearchRow): ArtifactSearchHit {
  return {
    ...mapArtifact(row),
    score: row.score,
    snippet: row.snippet ?? '',
  };
}

/** 读取单个产物；不存在返回 null。 */
export function getArtifact(db: DatabaseSync, id: string): Artifact | null {
  const row = db.prepare('SELECT rowid, * FROM artifacts WHERE id = ?').get(id) as unknown as
    | ArtifactRow
    | undefined;
  return row ? mapArtifact(row) : null;
}

/**
 * 插入产物并同步 FTS：主表与索引在同一事务内写入，任一失败整体回滚。
 * tags / findings 按 JSON 数组文本落库，FTS 原样索引该文本（与外部内容表一致）。
 */
export function insertArtifact(db: DatabaseSync, input: NewArtifactInput): Artifact {
  const task = db.prepare('SELECT id FROM tasks WHERE id = ?').get(input.taskId) as unknown as
    | { id: string }
    | undefined;
  if (!task) {
    throw new ContractError(ERROR_CODES.E_NOT_FOUND, `任务不存在: ${input.taskId}`);
  }

  const id = input.id ?? newArtifactId();
  const createdAt = input.now ?? Date.now();
  const tags = serializeStringArray(input.tags);
  const findings = serializeStringArray(input.findings);

  db.exec('BEGIN IMMEDIATE');
  try {
    const result = db
      .prepare(
        `INSERT INTO artifacts
          (id, task_id, run_id, kind, title, path, sha256, bytes, summary, tags,
           findings, trust, verified_by, verified_at, embedding, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        id,
        input.taskId,
        input.runId ?? null,
        input.kind,
        input.title,
        input.path ?? null,
        input.sha256 ?? null,
        input.bytes ?? null,
        input.summary,
        tags,
        findings,
        input.trust ?? 'unverified',
        input.verifiedBy ?? null,
        input.verifiedAt ?? null,
        createdAt,
      );
    const rowid = Number(result.lastInsertRowid);
    db.prepare(
      `INSERT INTO artifact_fts(rowid, title, summary, tags, findings)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(rowid, input.title, input.summary, tags, findings);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  const artifact = getArtifact(db, id);
  if (!artifact) {
    throw new ContractError(ERROR_CODES.E_INTERNAL, `产物插入后读回失败: ${id}`);
  }
  return artifact;
}

/**
 * 更新 title / summary / tags / findings，并在同一事务内重建该行的 FTS 条目。
 * 先按旧值 delete 再写新值，旧关键词会立即从索引中消失。
 */
export function updateArtifactSummary(
  db: DatabaseSync,
  artifactId: string,
  patch: ArtifactSummaryPatch,
): Artifact {
  const current = db.prepare('SELECT rowid, * FROM artifacts WHERE id = ?').get(artifactId) as unknown as
    | ArtifactRow
    | undefined;
  if (!current) {
    throw new ContractError(ERROR_CODES.E_NOT_FOUND, `产物不存在: ${artifactId}`);
  }

  const next = typeof patch === 'string' ? { summary: patch } : patch;
  if (
    next.title === undefined &&
    next.summary === undefined &&
    next.tags === undefined &&
    next.findings === undefined
  ) {
    throw new ContractError(ERROR_CODES.E_INVALID_ARGUMENT, '至少提供一个要更新的检索字段');
  }

  const title = next.title ?? current.title;
  const summary = next.summary ?? current.summary;
  const tags = next.tags === undefined ? current.tags : serializeStringArray(next.tags);
  const findings =
    next.findings === undefined ? current.findings : serializeStringArray(next.findings);

  db.exec('BEGIN IMMEDIATE');
  try {
    // 外部内容 FTS 的 delete 必须提供索引时的旧值；先删旧条目，再更新主表并写新条目。
    db.prepare(
      `INSERT INTO artifact_fts(artifact_fts, rowid, title, summary, tags, findings)
       VALUES ('delete', ?, ?, ?, ?, ?)`,
    ).run(current.rowid, current.title, current.summary, current.tags, current.findings);
    db.prepare(
      `UPDATE artifacts SET title = ?, summary = ?, tags = ?, findings = ? WHERE id = ?`,
    ).run(title, summary, tags, findings, artifactId);
    db.prepare(
      `INSERT INTO artifact_fts(rowid, title, summary, tags, findings)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(current.rowid, title, summary, tags, findings);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  const updated = getArtifact(db, artifactId);
  if (!updated) {
    throw new ContractError(ERROR_CODES.E_INTERNAL, `产物更新后读回失败: ${artifactId}`);
  }
  return updated;
}

/**
 * 检索产物，按 bm25 升序返回（越相关越靠前），带 snippet 高亮上下文。
 * - 所有词都 ≥3 字符：走 FTS5 MATCH + bm25 + snippet()。
 * - 任一词 <3 字符：trigram 无法 MATCH，退化为对四个索引列做 instr 过滤并手工高亮。
 */
export function searchArtifacts(
  db: DatabaseSync,
  query: string,
  limit?: number,
): ArtifactSearchHit[];
export function searchArtifacts(
  db: DatabaseSync,
  options: SearchArtifactsOptions,
): ArtifactSearchHit[];
export function searchArtifacts(
  db: DatabaseSync,
  queryOrOptions: string | SearchArtifactsOptions,
  limit: number = DEFAULT_SEARCH_LIMIT,
): ArtifactSearchHit[] {
  const query = typeof queryOrOptions === 'string' ? queryOrOptions : queryOrOptions.query;
  const requestedLimit =
    typeof queryOrOptions === 'string' ? limit : (queryOrOptions.limit ?? DEFAULT_SEARCH_LIMIT);
  const tokens = splitQuery(query);
  const max = normalizeLimit(requestedLimit);
  if (tokens.length === 0 || max === 0) return [];

  const tooShort = tokens.some((token) => countChars(token) < MIN_TRIGRAM_CHARS);
  return tooShort ? searchShortQuery(db, tokens, max) : searchFts(db, tokens, max);
}

function searchFts(db: DatabaseSync, tokens: string[], limit: number): ArtifactSearchHit[] {
  const match = tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' AND ');
  const rows = db
    .prepare(
      `SELECT ${ARTIFACT_COLUMNS},
              bm25(artifact_fts) AS score,
              snippet(artifact_fts, -1, '[', ']', '…', 32) AS snippet
         FROM artifact_fts
         JOIN artifacts AS a ON a.rowid = artifact_fts.rowid
        WHERE artifact_fts MATCH ?
        ORDER BY score ASC, a.created_at DESC
        LIMIT ?`,
    )
    .all(match, limit) as unknown as ArtifactSearchRow[];
  return rows.map(mapSearchRow);
}

function searchShortQuery(db: DatabaseSync, tokens: string[], limit: number): ArtifactSearchHit[] {
  const scoreParts: string[] = [];
  const scoreParams: string[] = [];
  for (const token of tokens) {
    scoreParts.push(
      `(CASE WHEN instr(lower(a.title), lower(?)) > 0 THEN 8 ELSE 0 END +
        CASE WHEN instr(lower(a.summary), lower(?)) > 0 THEN 4 ELSE 0 END +
        CASE WHEN instr(lower(a.tags), lower(?)) > 0 THEN 2 ELSE 0 END +
        CASE WHEN instr(lower(a.findings), lower(?)) > 0 THEN 1 ELSE 0 END)`,
    );
    scoreParams.push(token, token, token, token);
  }

  const whereParts: string[] = [];
  const whereParams: string[] = [];
  for (const token of tokens) {
    whereParts.push(
      `(instr(lower(a.title), lower(?)) > 0 OR instr(lower(a.summary), lower(?)) > 0
        OR instr(lower(a.tags), lower(?)) > 0 OR instr(lower(a.findings), lower(?)) > 0)`,
    );
    whereParams.push(token, token, token, token);
  }

  const rows = db
    .prepare(
      `SELECT ${ARTIFACT_COLUMNS},
              (${scoreParts.join(' + ')}) AS score
         FROM artifacts AS a
        WHERE ${whereParts.join(' AND ')}
        ORDER BY score DESC, a.created_at DESC
        LIMIT ?`,
    )
    .all(...scoreParams, ...whereParams, limit) as unknown as Omit<
    ArtifactSearchRow,
    'snippet'
  >[];

  return rows.map((row) => {
    const artifact = mapArtifact(row);
    return {
      ...artifact,
      score: row.score,
      snippet: makeSnippet(artifact, tokens),
    };
  });
}

function makeSnippet(artifact: Artifact, tokens: string[]): string {
  const fields = [
    artifact.title,
    artifact.summary,
    artifact.tags.join(' '),
    artifact.findings.join(' '),
  ];
  for (const field of fields) {
    const lower = field.toLowerCase();
    for (const token of tokens) {
      const index = lower.indexOf(token.toLowerCase());
      if (index === -1) continue;
      const start = Math.max(0, index - 24);
      const end = Math.min(field.length, index + token.length + 32);
      const prefix = start > 0 ? '…' : '';
      const suffix = end < field.length ? '…' : '';
      return (
        prefix +
        field.slice(start, index) +
        '[' +
        field.slice(index, index + token.length) +
        ']' +
        field.slice(index + token.length, end) +
        suffix
      );
    }
  }
  return artifact.summary;
}
