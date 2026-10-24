/**
 * 主线对话页（M6-03 起，M9-03 增加附件与引用）。
 *
 * 首屏 GET /messages 拉历史；发送后 POST /chat 用 fetch + ReadableStream 读 SSE
 * （EventSource 不支持 POST）。delta 先进入字符串缓冲，24ms 合批后才 setState，
 * 避免每个 token 触发一次渲染；请求中禁用发送，首段 delta 未到前显示「思考中…」。
 *
 * 附件：回形针 / 拖拽 / 粘贴图片三条入口，图片先 canvas 压缩；引用只拼文本，
 * 用户气泡再把开头的 blockquote 行渲染成灰色引用块。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
} from "react";
import { Alert, App as AntdApp, Button, Input, Spin, Tooltip } from "antd";
import { MessageOutlined, PaperClipOutlined, SendOutlined } from "@ant-design/icons";
import ReactMarkdown from "react-markdown";

import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";
import {
  compressImageFile,
  isImageMime,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MAX_TOTAL_ATTACHMENT_BYTES,
  MessageAttachments,
  PendingAttachmentChips,
  readFileBase64,
  type PendingAttachment,
} from "../components/ChatAttachmentViews";
import {
  buildQuotedMessage,
  ChatQuoteBar,
  splitQuotedMessage,
} from "../components/ChatQuoteBar";
import {
  listMessages,
  streamChat,
  type ChatAttachment,
  type ChatAttachmentInput,
  type ChatMessage,
} from "../chatApi";

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
  onQuote,
}: {
  message: ChatMessage;
  thinking: boolean;
  onQuote: (text: string) => void;
}) {
  const isUser = message.role === "user";
  const quoted = isUser ? splitQuotedMessage(message.text) : null;

  return (
    <div className={isUser ? "chat-row chat-row-user" : "chat-row chat-row-assistant"}>
      <div
        className={isUser ? "chat-avatar chat-avatar-user" : "chat-avatar chat-avatar-ai"}
        aria-hidden
      >
        {isUser ? "我" : "AI"}
      </div>
      <div className="chat-bubble-col">
        <div className="chat-bubble-wrap">
          <div className={isUser ? "chat-bubble chat-bubble-user" : "chat-bubble chat-bubble-ai"}>
            {isUser ? (
              <>
                {quoted !== null && quoted.quote !== null ? (
                  <blockquote className="chat-user-quote">{quoted.quote}</blockquote>
                ) : null}
                {quoted !== null && quoted.body.length > 0 ? (
                  <div className="chat-user-text">{quoted.body}</div>
                ) : null}
                {message.attachments === undefined ? null : (
                  <MessageAttachments attachments={message.attachments} />
                )}
              </>
            ) : message.text.length === 0 && thinking ? (
              <ThinkingDots />
            ) : (
              <>
                <div className="chat-markdown">
                  <ReactMarkdown>{message.text}</ReactMarkdown>
                </div>
                {message.attachments === undefined ? null : (
                  <MessageAttachments attachments={message.attachments} />
                )}
              </>
            )}
          </div>
          {isUser ? null : (
            <Tooltip title="引用这条回复" placement="bottom">
              <Button
                className="chat-quote-button"
                type="text"
                size="small"
                icon={<MessageOutlined />}
                disabled={message.text.length === 0}
                onClick={() => {
                  onQuote(message.text);
                }}
              >
                引用
              </Button>
            </Tooltip>
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
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [quote, setQuote] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const listRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const deltaBufferRef = useRef("");
  const flushTimerRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const attachmentsRef = useRef<PendingAttachment[]>([]);
  const previewUrlsRef = useRef<string[]>([]);

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
        item.id === assistantId ? { ...item, text: item.text + chunk } : item,
      ),
    );
  }, []);

  const replaceAttachments = useCallback((next: PendingAttachment[]): void => {
    attachmentsRef.current = next;
    setAttachments(next);
  }, []);

  const removeAttachment = useCallback(
    (key: string): void => {
      const target = attachmentsRef.current.find((item) => item.key === key);
      if (target?.previewUrl !== undefined) {
        URL.revokeObjectURL(target.previewUrl);
        previewUrlsRef.current = previewUrlsRef.current.filter(
          (url) => url !== target.previewUrl,
        );
      }
      replaceAttachments(
        attachmentsRef.current.filter((item) => item.key !== key),
      );
    },
    [replaceAttachments],
  );

  const addFiles = useCallback(
    async (files: readonly File[]): Promise<void> => {
      if (files.length === 0) return;
      const preparedFiles: File[] = [];
      for (const file of files) {
        try {
          preparedFiles.push(await compressImageFile(file));
        } catch {
          toast.error(`图片处理失败：${file.name}`);
        }
      }
      if (preparedFiles.length === 0) return;

      const next = [...attachmentsRef.current];
      for (const file of preparedFiles) {
        if (next.length >= MAX_ATTACHMENTS) {
          toast.error(`最多添加 ${MAX_ATTACHMENTS} 个附件`);
          break;
        }
        if (file.size > MAX_ATTACHMENT_BYTES) {
          toast.error(`附件 ${file.name} 超过 8MB`);
          continue;
        }
        const totalBytes =
          next.reduce((sum, item) => sum + item.size, 0) + file.size;
        if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
          toast.error("附件总量不能超过 16MB");
          break;
        }
        const mime = file.type.length > 0 ? file.type : "application/octet-stream";
        const previewUrl = isImageMime(mime) ? URL.createObjectURL(file) : undefined;
        if (previewUrl !== undefined) previewUrlsRef.current.push(previewUrl);
        next.push({
          key: localId("local-attachment"),
          name: file.name,
          mime,
          size: file.size,
          file,
          ...(previewUrl === undefined ? {} : { previewUrl }),
        });
      }
      replaceAttachments(next);
    },
    [replaceAttachments, toast],
  );

  // 首屏历史；卸载时中止在途对话并清掉未触发的合批定时器与本地预览 URL。
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
      for (const url of previewUrlsRef.current) URL.revokeObjectURL(url);
      previewUrlsRef.current = [];
    };
  }, []);

  // 新消息/流式增量后贴底。
  useEffect(() => {
    const element = listRef.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, [messages, sending]);

  const send = useCallback(async (): Promise<void> => {
    const text = input.trim();
    if (
      (text.length === 0 && attachments.length === 0) ||
      sending ||
      loadingHistory
    ) {
      return;
    }

    setSending(true);
    setError(null);

    const attachmentInputs: ChatAttachmentInput[] = [];
    try {
      for (const item of attachments) {
        attachmentInputs.push({
          name: item.name,
          mime: item.mime,
          dataBase64: await readFileBase64(item.file),
        });
      }
    } catch {
      setSending(false);
      toast.error("读取附件失败，请重试");
      return;
    }

    const outgoingText = quote === null ? text : buildQuotedMessage(quote, text);
    const localAttachments: ChatAttachment[] = attachments.map((item) => ({
      id: item.key,
      name: item.name,
      mime: item.mime,
      size: item.size,
      ...(item.previewUrl === undefined ? {} : { previewUrl: item.previewUrl }),
    }));
    const assistantId = localId("local-assistant");
    const now = Date.now();
    const userMessage: ChatMessage = {
      id: localId("local-user"),
      taskId: null,
      seq: 0,
      role: "user",
      text: outgoingText,
      ...(localAttachments.length === 0 ? {} : { attachments: localAttachments }),
      tokens: null,
      ts: now,
    };
    const assistantMessage: ChatMessage = {
      id: assistantId,
      taskId: null,
      seq: 0,
      role: "assistant",
      text: "",
      tokens: null,
      ts: now,
    };

    setMessages((prev) => [...prev, userMessage, assistantMessage]);
    setInput("");
    setQuote(null);
    // 预览 URL 仍被上面的本地消息引用，不能 revoke，留给卸载时统一清理。
    attachmentsRef.current = [];
    setAttachments([]);
    deltaBufferRef.current = "";

    const controller = new AbortController();
    abortRef.current = controller;
    let failed = false;

    try {
      await streamChat(
        outgoingText,
        attachmentInputs,
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
                item.id === assistantId ? { ...item, text: done.reply } : item,
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
            prev.filter((item) => item.id !== assistantId || item.text.trim().length > 0),
          );
        }
      }
    }
  }, [attachments, flushDeltas, input, loadingHistory, quote, sending, toast]);

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragActive(true);
  }, []);

  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>): void => {
    const related = event.relatedTarget;
    if (related instanceof Node && event.currentTarget.contains(related)) return;
    setDragActive(false);
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>): void => {
      event.preventDefault();
      setDragActive(false);
      const files = Array.from(event.dataTransfer.files);
      void addFiles(files);
    },
    [addFiles],
  );

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>): void => {
      const files = Array.from(event.clipboardData.files).filter((file) =>
        file.type.startsWith("image/"),
      );
      if (files.length === 0) return;
      event.preventDefault();
      void addFiles(files);
    },
    [addFiles],
  );

  return (
    <div
      className={dragActive ? "chat-page is-dragging" : "chat-page"}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
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
        {dragActive ? (
          <div className="chat-drop-overlay">
            <PaperClipOutlined />
            <span>松开以添加附件</span>
          </div>
        ) : null}
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
              description="试试问「帮我看下现在有哪些任务」，或拖一张图片进来。"
            />
          </div>
        ) : (
          <div className="chat-message-list">
            {messages.map((item) => (
              <MessageBubble
                key={item.id}
                message={item}
                thinking={sending && item.role === "assistant" && item.text.length === 0}
                onQuote={(text) => {
                  setQuote(text);
                }}
              />
            ))}
          </div>
        )}
      </div>

      <div className="chat-composer">
        {quote === null ? null : (
          <ChatQuoteBar
            text={quote}
            onClose={() => {
              setQuote(null);
            }}
          />
        )}
        <Input.TextArea
          variant="borderless"
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
          }}
          onPaste={handlePaste}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder="输入消息，Enter 发送，Shift+Enter 换行；可拖拽文件或粘贴图片"
          autoSize={{ minRows: 2, maxRows: 6 }}
          disabled={sending || loadingHistory}
          maxLength={8000}
        />
        <PendingAttachmentChips
          items={attachments}
          disabled={sending || loadingHistory}
          onRemove={removeAttachment}
        />
        <div className="chat-composer-footer">
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              style={{ display: "none" }}
              onChange={(event) => {
                const files = event.target.files === null ? [] : Array.from(event.target.files);
                event.target.value = "";
                void addFiles(files);
              }}
            />
            <Tooltip title="添加附件（最多 5 个，单个不超过 8MB）" placement="top">
              <Button
                type="text"
                size="small"
                icon={<PaperClipOutlined />}
                disabled={sending || loadingHistory}
                aria-label="添加附件"
                onClick={() => {
                  fileInputRef.current?.click();
                }}
              />
            </Tooltip>
            <span className="chat-composer-hint">
              Enter 发送 · Shift+Enter 换行 · 可拖拽/粘贴
            </span>
          </div>
          <Button
            className="send-button"
            type="primary"
            icon={<SendOutlined />}
            loading={sending}
            disabled={
              sending ||
              loadingHistory ||
              (input.trim().length === 0 && attachments.length === 0)
            }
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
