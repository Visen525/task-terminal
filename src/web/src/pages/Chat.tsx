/**
 * 主线对话页（M6-03）。
 *
 * 首屏 GET /messages 拉历史；发送后 POST /chat 用 fetch + ReadableStream 读 SSE
 * （EventSource 不支持 POST）。delta 先进入字符串缓冲，24ms 合批后才 setState，
 * 避免每个 token 触发一次渲染；请求中禁用发送，首段 delta 未到前显示「思考中…」。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, App as AntdApp, Button, Input, Spin, Tooltip } from "antd";
import { MessageOutlined, PaperClipOutlined, SendOutlined } from "@ant-design/icons";
import ReactMarkdown from "react-markdown";

import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";
import { listMessages, streamChat, type ChatMessage } from "../chatApi";

/** 16–32ms 合批窗口，取中间值。 */
const FLUSH_INTERVAL_MS = 24;
const HISTORY_LIMIT = 50;

function localId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ThinkingDots() {
  return (
    <span className="thinking" role="status" aria-label="思考中">
      <span className="thinking-dots" aria-hidden>
        <span />
        <span />
        <span />
      </span>
    </span>
  );
}

function MessageBubble({
  message,
  thinking,
}: {
  message: ChatMessage;
  thinking: boolean;
}) {
  const isUser = message.role === "user";

  return (
    <div className={isUser ? "chat-row chat-row-user" : "chat-row chat-row-assistant"}>
      <div
        className={isUser ? "chat-avatar chat-avatar-user" : "chat-avatar chat-avatar-ai"}
        aria-hidden
      >
        {isUser ? "我" : "AI"}
      </div>
      <div className="chat-bubble-col">
        <div className={isUser ? "chat-bubble chat-bubble-user" : "chat-bubble chat-bubble-ai"}>
          {isUser ? (
            message.content
          ) : message.content.length === 0 && thinking ? (
            <ThinkingDots />
          ) : (
            <div className="chat-markdown">
              <ReactMarkdown>{message.content}</ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Chat() {
  const { message: toast } = AntdApp.useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const listRef = useRef<HTMLDivElement | null>(null);
  const deltaBufferRef = useRef("");
  const flushTimerRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  /** 每次 flush 只调用一次 setMessages；空缓冲直接返回。 */
  const flushDeltas = useCallback((assistantId: string): void => {
    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    const chunk = deltaBufferRef.current;
    if (chunk.length === 0) return;
    deltaBufferRef.current = "";
    if (!mountedRef.current) return;
    setMessages((prev) =>
      prev.map((item) =>
        item.id === assistantId ? { ...item, content: item.content + chunk } : item,
      ),
    );
  }, []);

  // 首屏历史；卸载时中止在途对话并清掉未触发的合批定时器。
  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    listMessages(HISTORY_LIMIT)
      .then((history) => {
        if (cancelled) return;
        setMessages(history);
      })
      .catch((historyError: unknown) => {
        if (cancelled) return;
        setError(historyError instanceof Error ? historyError.message : String(historyError));
      })
      .finally(() => {
        if (!cancelled) setLoadingHistory(false);
      });

    return () => {
      cancelled = true;
      mountedRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
      if (flushTimerRef.current !== null) {
        window.clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      deltaBufferRef.current = "";
    };
  }, []);

  // 新消息/流式增量后贴底。
  useEffect(() => {
    const element = listRef.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, [messages, sending]);

  const send = useCallback(async (): Promise<void> => {
    const text = input.trim();
    if (text.length === 0 || sending || loadingHistory) return;

    const assistantId = localId("local-assistant");
    const now = Date.now();
    const userMessage: ChatMessage = {
      id: localId("local-user"),
      taskId: null,
      seq: 0,
      role: "user",
      content: text,
      tokens: null,
      ts: now,
    };
    const assistantMessage: ChatMessage = {
      id: assistantId,
      taskId: null,
      seq: 0,
      role: "assistant",
      content: "",
      tokens: null,
      ts: now,
    };

    setMessages((prev) => [...prev, userMessage, assistantMessage]);
    setInput("");
    setSending(true);
    setError(null);
    deltaBufferRef.current = "";

    const controller = new AbortController();
    abortRef.current = controller;
    let failed = false;

    try {
      await streamChat(
        text,
        {
          onDelta: (delta) => {
            deltaBufferRef.current += delta;
            if (flushTimerRef.current !== null) return;
            flushTimerRef.current = window.setTimeout(() => {
              flushTimerRef.current = null;
              flushDeltas(assistantId);
            }, FLUSH_INTERVAL_MS);
          },
          onDone: (done) => {
            flushDeltas(assistantId);
            if (!mountedRef.current) return;
            // done.reply 是服务端落库的完整回复；用它兜底替换流式拼接结果。
            setMessages((prev) =>
              prev.map((item) =>
                item.id === assistantId ? { ...item, content: done.reply } : item,
              ),
            );
          },
          onError: (streamError) => {
            failed = true;
            if (mountedRef.current) {
              setError(`${streamError.code}: ${streamError.message}`);
            }
          },
        },
        controller.signal,
      );
    } catch (sendError) {
      if (!controller.signal.aborted) {
        failed = true;
        if (mountedRef.current) {
          setError(sendError instanceof Error ? sendError.message : String(sendError));
          toast.error("发送失败");
        }
      }
    } finally {
      flushDeltas(assistantId);
      if (abortRef.current === controller) abortRef.current = null;
      if (mountedRef.current) {
        setSending(false);
        if (failed) {
          // 一个字都没收到就失败时不要留空气泡；有部分内容则保留。
          setMessages((prev) =>
            prev.filter((item) => item.id !== assistantId || item.content.trim().length > 0),
          );
        }
      }
    }
  }, [flushDeltas, input, loadingHistory, sending, toast]);

  return (
    <div className="chat-page">
      <PageHeader
        eyebrow="Chat"
        title="对话"
        subtitle="主 AI 常驻会话；需要动手时会派任务给子智能体。"
      />

      {error === null ? null : (
        <Alert
          type="error"
          showIcon
          closable
          message="对话出错"
          description={error}
          onClose={() => {
            setError(null);
          }}
          style={{ marginBottom: 12 }}
        />
      )}

      <div ref={listRef} className="chat-panel">
        {loadingHistory ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              height: "100%",
              color: "var(--tt-text-secondary)",
            }}
          >
            <Spin />
            <span>加载历史对话…</span>
          </div>
        ) : messages.length === 0 ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
            }}
          >
            <EmptyState
              compact
              icon={<MessageOutlined />}
              title="还没有对话"
              description="试试问「帮我看下现在有哪些任务」。"
            />
          </div>
        ) : (
          <div className="chat-message-list">
            {messages.map((item) => (
              <MessageBubble
                key={item.id}
                message={item}
                thinking={sending && item.role === "assistant" && item.content.length === 0}
              />
            ))}
          </div>
        )}
      </div>

      <div className="chat-composer">
        <Input.TextArea
          variant="borderless"
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder="输入消息，Enter 发送，Shift+Enter 换行"
          autoSize={{ minRows: 2, maxRows: 6 }}
          disabled={sending || loadingHistory}
          maxLength={8000}
        />
        <div className="chat-composer-footer">
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <Tooltip title="附件功能将在 M9-03 开放" placement="top">
              <Button
                type="text"
                size="small"
                icon={<PaperClipOutlined />}
                disabled
                aria-label="添加附件（M9-03 开放）"
              />
            </Tooltip>
            <span className="chat-composer-hint">Enter 发送 · Shift+Enter 换行</span>
          </div>
          <Button
            className="send-button"
            type="primary"
            icon={<SendOutlined />}
            loading={sending}
            disabled={sending || loadingHistory || input.trim().length === 0}
            onClick={() => {
              void send();
            }}
          >
            {sending ? "回复中…" : "发送"}
          </Button>
        </div>
      </div>
    </div>
  );
}
