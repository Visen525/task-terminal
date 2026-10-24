/**
 * 主线对话 API（M6-03）。
 *
 * EventSource 不支持 POST，因此 /chat 用 fetch + ReadableStream 手写 SSE 解析。
 * 本文件只负责“网络 + 协议”，合批渲染由 Chat 页面控制；所有路径保持相对。
 */

export type ChatRole = "user" | "assistant" | "tool";

export interface ChatAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  /** 服务端逻辑路径；前端不依赖它取文件。 */
  path?: string;
  /** 本地待发送/刚发送时的 object URL 预览；服务端不返回。 */
  previewUrl?: string;
}

export interface ChatAttachmentInput {
  name: string;
  mime: string;
  dataBase64: string;
}

export interface ChatMessage {
  id: string;
  taskId: string | null;
  seq: number;
  role: ChatRole;
  /** 纯文本视图（v1.1 GET /messages）；附件另见 attachments。 */
  text: string;
  attachments?: ChatAttachment[];
  /** 思考链全文（M13-02）；仅 assistant 且模型产出思考时存在。 */
  reasoning?: string;
  tokens: number | null;
  ts: number;
}

export interface ChatUsage {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ChatDone {
  reply: string;
  usage: ChatUsage;
}

export interface ChatStreamError {
  code: string;
  message: string;
}

export interface ChatStreamHandlers {
  onDelta: (text: string) => void;
  /** 思考链增量（M13-02）；模型不开思考时不会触发。 */
  onReasoning?: (text: string) => void;
  onDone: (done: ChatDone) => void;
  onError: (error: ChatStreamError) => void;
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
    // 非 JSON 错误体：原文更有诊断价值。
    return text;
  }
  return fallback;
}

/** GET /messages?limit=，返回主线历史（时间正序）。 */
export async function listMessages(limit = 50): Promise<ChatMessage[]> {
  const response = await fetch(`/messages?limit=${encodeURIComponent(String(limit))}`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  const body: unknown = await response.json();
  if (!Array.isArray(body)) {
    throw new Error("GET /messages 返回格式不合法");
  }
  // 兼容旧后端（只有 content）：新字段 text 为准，缺省时回退。
  return (body as Array<ChatMessage & { content?: unknown }>).map((row) => ({
    ...row,
    text:
      typeof row.text === "string"
        ? row.text
        : typeof row.content === "string"
          ? row.content
          : "",
  }));
}

interface ParsedFrame {
  event: string;
  data: string;
}

function parseFrame(raw: string): ParsedFrame | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    const value = line.slice(colon + 1).replace(/^ /u, "");
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

function handleFrame(frame: ParsedFrame, handlers: ChatStreamHandlers): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame.data);
  } catch {
    handlers.onError({ code: "E_INVALID_SSE", message: "服务端流式帧不是合法 JSON" });
    return;
  }
  if (!isRecord(parsed)) return;

  if (frame.event === "delta") {
    if (typeof parsed.text === "string" && parsed.text.length > 0) {
      handlers.onDelta(parsed.text);
    }
    return;
  }
  if (frame.event === "reasoning") {
    if (typeof parsed.text === "string" && parsed.text.length > 0) {
      handlers.onReasoning?.(parsed.text);
    }
    return;
  }
  if (frame.event === "done") {
    const reply = typeof parsed.reply === "string" ? parsed.reply : "";
    const rawUsage = isRecord(parsed.usage) ? parsed.usage : {};
    const numberField = (key: string): number => {
      const value = rawUsage[key];
      return typeof value === "number" && Number.isFinite(value) ? value : 0;
    };
    handlers.onDone({
      reply,
      usage: {
        inputTokens: numberField("inputTokens"),
        cachedTokens: numberField("cachedTokens"),
        outputTokens: numberField("outputTokens"),
        totalTokens: numberField("totalTokens"),
      },
    });
    return;
  }
  if (frame.event === "error") {
    handlers.onError({
      code: typeof parsed.code === "string" ? parsed.code : "E_INTERNAL",
      message: typeof parsed.message === "string" ? parsed.message : "对话失败",
    });
  }
}

/**
 * POST /chat 并消费 SSE。
 * 正常结束 resolve；HTTP 非 2xx 或网络错误 reject；流内 error 事件走 onError。
 * attachments 只在非空时进入 body，保持纯文本请求与 M6 行为一致。
 */
export async function streamChat(
  message: string,
  attachments: readonly ChatAttachmentInput[],
  handlers: ChatStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const payload: Record<string, unknown> = { message };
  if (attachments.length > 0) payload.attachments = attachments;
  const response = await fetch("/chat", {
    method: "POST",
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    ...(signal === undefined ? {} : { signal }),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  if (response.body === null) {
    throw new Error("POST /chat 响应缺少流式响应体");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const drain = (): void => {
    for (;;) {
      const index = buffer.indexOf("\n\n");
      if (index < 0) return;
      const raw = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const frame = parseFrame(raw);
      if (frame !== null) handleFrame(frame, handlers);
    }
  };

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/gu, "\n");
      drain();
    }
    buffer += decoder.decode().replace(/\r\n/gu, "\n");
    if (buffer.trim().length > 0) {
      const frame = parseFrame(buffer);
      if (frame !== null) handleFrame(frame, handlers);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // 流已正常结束或客户端已中止时，取消失败不覆盖已交付结果。
    }
  }
}
