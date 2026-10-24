/**
 * 产物检索排序（SPEC §7 M7-01）。
 *
 * 两段式：先复用 store/artifacts.ts 的 FTS / 短词退化检索取最多 50 个候选，
 * 再按下面的分数重排并取前 N（默认 8）：
 *
 *   score = bm25 归一 + 时间衰减 * 0.3 + tag 命中 * 0.2
 *
 * - bm25 归一：FTS 路径 bm25 越小（更负）越相关，短词退化路径字段分越高越相关，
 *   两条路径分别按 min/max 映射到 [0, 1]；
 * - 时间衰减：exp(-ageDays / 30)，30 天约衰减到 0.37；
 * - tag 命中：query 分词命中 tags 的比例，最多贡献 0.2。
 *
 * 正文/path 不参与索引，候选与 snippet 都来自既有 artifacts 仓储。
 */
import type { DatabaseSync } from "node:sqlite";

import { searchArtifacts, type ArtifactSearchHit } from "../store/artifacts.ts";

/** 默认返回条数（SPEC：候选 50 → 取 8）。 */
export const RANKED_ARTIFACT_LIMIT = 8;
/** FTS 候选池大小。 */
export const RANKED_ARTIFACT_CANDIDATES = 50;
/** 时间衰减权重。 */
export const TIME_DECAY_WEIGHT = 0.3;
/** tag 命中权重。 */
export const TAG_HIT_WEIGHT = 0.2;
/** 时间衰减的半衰尺度（天）。 */
export const TIME_DECAY_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_TRIGRAM_CHARS = 3;

export interface SearchArtifactsRankedOptions {
  query: string;
  /** 默认 8。 */
  limit?: number;
  /** 可注入时钟（毫秒时间戳或函数）；默认 Date.now。 */
  now?: number | (() => number);
}

function normalizeLimit(limit: number): number {
  if (!Number.isFinite(limit)) return RANKED_ARTIFACT_LIMIT;
  const value = Math.floor(limit);
  return value < 0 ? 0 : value;
}

function splitQuery(query: string): string[] {
  return query
    .trim()
    .split(/\s+/u)
    .filter((token) => token.length > 0);
}

function charCount(value: string): number {
  return [...value].length;
}

function countTagHits(tags: readonly string[], tokens: readonly string[]): number {
  if (tokens.length === 0) return 0;
  let hits = 0;
  for (const token of tokens) {
    const needle = token.toLowerCase();
    if (tags.some((tag) => tag.toLowerCase().includes(needle))) hits += 1;
  }
  return hits;
}

function normalizeRelevance(
  scores: readonly number[],
  shortQuery: boolean,
): (score: number) => number {
  if (scores.length === 0) return () => 0;
  let min = scores[0] as number;
  let max = scores[0] as number;
  for (const score of scores) {
    if (score < min) min = score;
    if (score > max) max = score;
  }
  const span = max - min;
  if (span === 0) return () => 1;
  // FTS bm25 越低越相关；短词退化的字段分越高越相关。
  return shortQuery ? (score) => (score - min) / span : (score) => (max - score) / span;
}

/**
 * 检索产物并重排。返回既有 artifact 字段 + 复合 score + snippet。
 */
export function searchArtifactsRanked(
  db: DatabaseSync,
  options: SearchArtifactsRankedOptions,
): ArtifactSearchHit[] {
  const limit = normalizeLimit(options.limit ?? RANKED_ARTIFACT_LIMIT);
  if (limit === 0) return [];

  const query = options.query;
  const tokens = splitQuery(query);
  if (tokens.length === 0) return [];

  const candidates = searchArtifacts(db, {
    query,
    limit: RANKED_ARTIFACT_CANDIDATES,
  });
  if (candidates.length === 0) return [];

  const shortQuery = tokens.some((token) => charCount(token) < MIN_TRIGRAM_CHARS);
  const relevanceOf = normalizeRelevance(
    candidates.map((candidate) => candidate.score),
    shortQuery,
  );
  const now =
    typeof options.now === "function"
      ? options.now()
      : typeof options.now === "number" && Number.isFinite(options.now)
        ? Math.floor(options.now)
        : Date.now();

  const ranked = candidates.map((candidate) => {
    const relevance = relevanceOf(candidate.score);
    const ageDays = Math.max(0, now - candidate.createdAt) / DAY_MS;
    const timeDecay = Math.exp(-ageDays / TIME_DECAY_DAYS) * TIME_DECAY_WEIGHT;
    const tagHits = countTagHits(candidate.tags, tokens) / tokens.length;
    const score = relevance + timeDecay + tagHits * TAG_HIT_WEIGHT;
    return { ...candidate, score };
  });

  ranked.sort(
    (left, right) =>
      right.score - left.score ||
      right.createdAt - left.createdAt ||
      left.id.localeCompare(right.id),
  );
  return ranked.slice(0, limit);
}
