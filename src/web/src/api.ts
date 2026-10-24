/**
 * 前端 REST 封装（M6-01）。
 *
 * 只走相对路径：开发期由 Vite dev server 代理到 127.0.0.1:4310，
 * 构建后同源部署由后端/静态服务器承接。这里不写死任何主机名或绝对路径。
 */

export type TaskStatus =
  "queued" | "running" | "completed" | "failed" | "waiting_input" | "cancelled";

export type PermissionMode = "read-only" | "workspace-write";

export interface Task {
  id: string;
  parentId: string | null;
  title: string;
  goal: string;
  status: TaskStatus;
  revision: number;
  permission: PermissionMode;
  workspace: string;
  budgetTokens: number;
  spentTokens: number;
  resultJson: string | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

export interface TaskEvent {
  seq: number;
  taskId: string | null;
  runId: string | null;
  ts: number;
  type: string;
  actor: string;
  payload: unknown;
}

export interface TaskDetail {
  task: Task;
  events: TaskEvent[];
}

export interface CreateTaskInput {
  title: string;
  goal: string;
  permission: PermissionMode;
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
    // 非 JSON 错误体：原文比 HTTP 状态码更有诊断价值，继续返回 text。
    return text;
  }
  return text;
}

interface RequestOptions {
  method?: "GET" | "POST";
  body?: string;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: {
      Accept: "application/json",
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: options.body }),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  return (await response.json()) as T;
}

/** GET /tasks，默认按创建时间升序返回最近 100 条。 */
export function listTasks(): Promise<Task[]> {
  return request<Task[]>("/tasks");
}

/** GET /tasks/:id，含最近 20 条事件。 */
export function getTaskDetail(taskId: string): Promise<TaskDetail> {
  return request<TaskDetail>(`/tasks/${encodeURIComponent(taskId)}`);
}

/** POST /tasks，成功后返回 201 与新建任务。 */
export function createTask(input: CreateTaskInput): Promise<Task> {
  return request<Task>("/tasks", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
