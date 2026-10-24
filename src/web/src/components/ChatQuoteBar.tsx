/**
 * 对话引用条与用户气泡内的 blockquote 解析（M9-03）。
 *
 * 引用只拼进消息文本，不改后端协议：
 *   > 引用：
 *   > <原文>
 *
 * <用户输入>
 * 模型天然读得懂 blockquote；展示层再把用户气泡开头的 > 行渲染成灰色引用块。
 */
import { Button } from "antd";
import { CloseOutlined } from "@ant-design/icons";

export const QUOTE_PREVIEW_CHARS = 80;

export function buildQuotedMessage(quote: string, input: string): string {
  const normalized = quote.replace(/\r\n?/gu, "\n").trimEnd();
  const quotedLines = normalized
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `> 引用：\n${quotedLines}\n\n${input}`;
}

export interface QuotedMessageParts {
  /** 开头的连续 `>` 行（去掉 `> ` 前缀）；没有引用时为 null。 */
  quote: string | null;
  body: string;
}

/** 纯展示层解析：只认消息开头连续的 blockquote 行，其余原样保留。 */
export function splitQuotedMessage(text: string): QuotedMessageParts {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  let index = 0;
  const quoteLines: string[] = [];
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!/^\s*>/u.test(line)) break;
    quoteLines.push(line.replace(/^\s*>\s?/u, ""));
    index += 1;
  }
  if (quoteLines.length === 0) return { quote: null, body: text };
  while (index < lines.length && (lines[index] ?? "").trim().length === 0) {
    index += 1;
  }
  const quote = quoteLines.join("\n").trim();
  return {
    quote: quote.length > 0 ? quote : null,
    body: lines.slice(index).join("\n"),
  };
}

function quotePreview(text: string): string {
  const compact = text.replace(/\s+/gu, " ").trim();
  const chars = [...compact];
  return chars.length > QUOTE_PREVIEW_CHARS
    ? `${chars.slice(0, QUOTE_PREVIEW_CHARS).join("")}…`
    : compact;
}

export function ChatQuoteBar({
  text,
  onClose,
}: {
  text: string;
  onClose: () => void;
}) {
  return (
    <div className="chat-quote-bar" role="note" aria-label="当前引用">
      <span className="chat-quote-label">引用</span>
      <span className="chat-quote-text" title={text}>
        {quotePreview(text)}
      </span>
      <Button
        type="text"
        size="small"
        icon={<CloseOutlined />}
        aria-label="取消引用"
        onClick={onClose}
      />
    </div>
  );
}
