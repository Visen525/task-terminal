/**
 * 主线对话页（M6-03）。
 *
 * 首屏 GET /messages 拉历史；发送后 POST /chat 用 fetch + ReadableStream 读 SSE
 * （EventSource 不支持 POST）。delta 先进入字符串缓冲，24ms 合批后才 setState，
 * 避免每个 token 触发一次渲染；请求中禁用发送，首段 delta 未到前显示「思考中…」。
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Alert, App as AntdApp, Button, Empty, Input, Space, Spin, Typography } from "antd";
import ReactMarkdown from "react-markdown";

import { listMessages, streamChat, type ChatMessage } from "../chatApi";

/** 16–32ms 合批窗口，取中间值。 */
const FLUSH_INTERVAL_MS = 24;
const HISTORY_LIMIT = 50;

function localId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const bubbleBase: CSSProperties = {
  maxWidth: "78%",
  padding: "10px 14px",
  borderRadius: 12,
  lineHeight: 1.7,
  wordBreak: "break-word",
};

function MessageBubble({
  message,
  thinking,
}: {
  message: ChatMessage;
  thinking: boolean;
}) {
  const isUser = message.role === "user";
  const bubbleStyle: CSSProperties = isUser
    ? {
        ...bubbleBase,
        marginLeft: "auto",
        background: "#1677ff",
        color: "#fff",
        whiteSpace: "pre-wrap",
      }
    : {
        ...bubbleBase,
        marginRight: "auto",
        background: "#fff",
        border: "1px solid #f0f0f0",
        boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
      };

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: isUser ? "flex-end" : "flex-start" }}>
      <Typography.Text type="secondary" style={{ fontSize: 12, marginBottom: 4 }}>
        {isUser ? "我" : "主 AI"}
      </Typography.Text>
      <div style={bubbleStyle}>
        {isUser ? (
          message.content
        ) : message.content.length === 0 && thinking ? (
          <Space size={8}>
            <Spin size="small" />
            <Typography.Text type="secondary">思考中…</Typography.Text>
          </Space>
        ) : (
          <div className="chat-markdown">
            <ReactMarkdown>{message.content}</ReactMarkdown>
          </div>
        )}
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
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "calc(100vh - 160px)",
        minHeight: 480,
      }}
    >
      <div style={{ marginBottom: 12 }}>
        <Typography.Title level={3} style={{ margin: 0 }}>
          对话
        </Typography.Title>
        <Typography.Text type="secondary">
          主 AI 常驻会话；需要动手时会派任务给子智能体。
        </Typography.Text>
      </div>

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

      <div
        ref={listRef}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: 16,
          background: "#fafafa",
          border: "1px solid #f0f0f0",
          borderRadius: 8,
        }}
      >
        {loadingHistory ? (
          <Space size={10} style={{ padding: 24 }}>
            <Spin />
            <span>加载历史对话…</span>
          </Space>
        ) : messages.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="还没有对话。试试问「帮我看下现在有哪些任务」。"
            style={{ marginTop: 72 }}
          />
        ) : (
          <Space direction="vertical" size={16} style={{ width: "100%" }}>
            {messages.map((item) => (
              <MessageBubble
                key={item.id}
                message={item}
                thinking={sending && item.role === "assistant" && item.content.length === 0}
              />
            ))}
          </Space>
        )}
      </div>

      <div style={{ marginTop: 12 }}>
        <Input.TextArea
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
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
          <Button
            type="primary"
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
