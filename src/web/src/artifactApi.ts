/**
 * 产物库 API（M6-03）：只走相对路径，不直接接触数据库或产物文件。
 */

export type ArtifactTrust = "unverified" | "verified" | "failed";
export type ArtifactKind = "file" | "note" | "dataset" | "patch";

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

export interface ArtifactHit extends Artifact {
  score: number;
  snippet: string;
}

export type ArtifactMode = "browse" | "search";

export interface ArtifactBrowseResult {
  mode: "browse";
  total: number;
  items: Artifact[];
}

export interface ArtifactSearchResult {
  mode: "search";
  total: number;
  items: ArtifactHit[];
}

export type ArtifactListResult = ArtifactBrowseResult | ArtifactSearchResult;

export interface ListArtifactsOptions {
  kind?: ArtifactKind;
  limit?: number;
  offset?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function parseArtifactListResponse(body: unknown): ArtifactListResult {
  if (!isRecord(body)) {
    throw new Error("GET /artifacts 返回格式不合法");
  }
  const { mode, total, items } = body;
  if (mode !== "browse" && mode !== "search") {
    throw new Error("GET /artifacts 返回的 mode 不合法");
  }
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0) {
    throw new Error("GET /artifacts 返回的 total 不合法");
  }
  if (!Array.isArray(items)) {
    throw new Error("GET /artifacts 返回的 items 不合法");
  }
  for (const item of items) {
    if (!isRecord(item) || typeof item.id !== "string") {
      throw new Error("GET /artifacts 返回的产物条目不合法");
    }
  }
  return { mode, total, items } as ArtifactListResult;
}

async function requestArtifactList(params: URLSearchParams): Promise<ArtifactListResult> {
  const response = await fetch(`/artifacts?${params.toString()}`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  return parseArtifactListResponse(await response.json());
}

/** GET /artifacts：无 query，浏览全部产物（created_at 倒序，服务端分页）。 */
export async function listArtifacts(
  options: ListArtifactsOptions = {},
): Promise<ArtifactBrowseResult> {
  const params = new URLSearchParams();
  if (options.kind !== undefined) params.set("kind", options.kind);
  params.set("limit", String(options.limit ?? 24));
  params.set("offset", String(options.offset ?? 0));
  const result = await requestArtifactList(params);
  if (result.mode !== "browse") {
    throw new Error("GET /artifacts 浏览响应 mode 不合法");
  }
  return result;
}

/** GET /artifacts?query=：检索命中按相关度排序，total 为本次命中数。 */
export async function searchArtifacts(
  query: string,
  limit = 30,
): Promise<ArtifactSearchResult> {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    throw new Error("搜索关键词不能为空");
  }
  const params = new URLSearchParams();
  params.set("query", trimmed);
  params.set("limit", String(limit));
  const result = await requestArtifactList(params);
  if (result.mode !== "search") {
    throw new Error("GET /artifacts 搜索响应 mode 不合法");
  }
  return result;
}

/** GET /artifacts/:id，单产物详情。 */
export async function getArtifact(artifactId: string): Promise<Artifact> {
  const response = await fetch(`/artifacts/${encodeURIComponent(artifactId)}`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  const body: unknown = await response.json();
  if (!isRecord(body) || typeof body.id !== "string") {
    throw new Error("GET /artifacts/:id 返回格式不合法");
  }
  return body as unknown as Artifact;
}
