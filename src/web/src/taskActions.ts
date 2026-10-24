/**
 * 任务详情页的操作型 REST 调用（M6-02）。
 *
 * api.ts 只读 GET/POST 创建；取消/重试是详情页专属动作，放在这里避免改动
 * M6-01 已冻结的 api.ts。仍然只使用相对路径。
 */
import type { Task } from "./api";

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
  return text;
}

async function postTaskAction(
  taskId: string,
  action: "cancel" | "retry",
  body: Record<string, unknown>,
): Promise<Task> {
  const response = await fetch(`/tasks/${encodeURIComponent(taskId)}/${action}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  return (await response.json()) as Task;
}

export function cancelTask(taskId: string, reason = "用户取消"): Promise<Task> {
  return postTaskAction(taskId, "cancel", { reason });
}

export function retryTask(taskId: string): Promise<Task> {
  return postTaskAction(taskId, "retry", {});
}
