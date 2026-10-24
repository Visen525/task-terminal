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

/** GET /artifacts?query=&limit=，搜索命中按相关度排序。 */
export async function searchArtifacts(query: string, limit = 30): Promise<ArtifactHit[]> {
  const params = new URLSearchParams();
  if (query.trim().length > 0) params.set("query", query.trim());
  params.set("limit", String(limit));
  const response = await fetch(`/artifacts?${params.toString()}`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  const body: unknown = await response.json();
  if (!Array.isArray(body)) {
    throw new Error("GET /artifacts 返回格式不合法");
  }
  return body as ArtifactHit[];
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
