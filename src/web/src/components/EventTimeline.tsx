/**
 * 执行时间线（M6-02）。
 *
 * 用 @tanstack/react-virtual 做动态行高虚拟列表：只挂载可视区 + overscan 内的行，
 * 100+ 事件时 DOM 行数仍保持在十几个量级。行内容按事件类型渲染，payload 原文
 * 默认折叠，避免 JSON 撑爆首屏。
 */
import {
  useCallback,
  useEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
  type UIEvent,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Empty, Space, Tag, Typography } from "antd";
import ReactMarkdown from "react-markdown";

import type { TaskEvent } from "../api";

const { Text } = Typography;

const PREVIEW_STYLE: CSSProperties = {
  margin: "6px 0 0",
  padding: "8px 10px",
  background: "#fafafa",
  border: "1px solid #f0f0f0",
  borderRadius: 6,
  fontSize: 12,
  lineHeight: 1.55,
  maxHeight: 220,
  overflow: "auto",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};

const ROW_STYLE: CSSProperties = {
  position: "relative",
  padding: "10px 12px 10px 26px",
  border: "1px solid #f0f0f0",
  borderRadius: 8,
  background: "#fff",
};

const TASK_ROW_STYLE: CSSProperties = {
  ...ROW_STYLE,
  background: "#fafafa",
};

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const EVENT_COLORS: Record<string, string> = {
  "task.created": "blue",
  "task.queued": "default",
  "task.started": "processing",
  "task.completed": "success",
  "task.failed": "error",
  "task.cancelled": "default",
  "agent.step": "geekblue",
  "agent.message": "cyan",
  "agent.tool_call": "orange",
  "agent.tool_result": "green",
  "llm.call": "purple",
  "artifact.created": "gold",
  "summary.generated": "gold",
  "budget.warning": "warning",
  "memory.fact_upserted": "magenta",
};

const ACTOR_LABELS: Record<string, string> = {
  user: "用户",
  main: "主线",
  agent: "子智能体",
  system: "系统",
};

const TASK_EVENT_LABELS: Record<string, string> = {
  "task.created": "任务创建",
  "task.queued": "进入队列",
  "task.started": "开始执行",
  "task.completed": "任务完成",
  "task.failed": "任务失败",
  "task.cancelled": "任务取消",
};

interface EventTimelineProps {
  events: TaskEvent[];
  /** 新事件到达时是否跟随到底部；用户在底部才生效。 */
  autoFollow: boolean;
  /** running 时在标题栏给一个实时提示。 */
  running: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function payloadOf(event: TaskEvent): Record<string, unknown> {
  return isRecord(event.payload) ? event.payload : {};
}

function stringValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function numberValue(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatTime(timestamp: number): string {
  return DATE_TIME_FORMATTER.format(new Date(timestamp));
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return String(value);
  }
}

function taskEventSummary(event: TaskEvent): ReactNode {
  const payload = payloadOf(event);
  switch (event.type) {
    case "task.created": {
      const title = stringValue(payload, "title");
      const goal = stringValue(payload, "goal");
      return (
        <Space direction="vertical" size={2}>
          {title === undefined ? null : <Text strong>{title}</Text>}
          {goal === undefined ? null : <Text type="secondary">{goal}</Text>}
        </Space>
      );
    }
    case "task.failed": {
      const reason = stringValue(payload, "reason") ?? "未知原因";
      const attempt = numberValue(payload, "attempt");
      const code = stringValue(payload, "error_code");
      return (
        <Space size={8} wrap>
          <Text type="danger">{reason}</Text>
          {attempt === undefined ? null : <Text type="secondary">attempt {attempt}</Text>}
          {code === undefined ? null : <Text code>{code}</Text>}
        </Space>
      );
    }
    case "task.cancelled": {
      return <Text>{stringValue(payload, "reason") ?? "用户取消"}</Text>;
    }
    case "task.completed": {
      return <Text type="success">已提交结构化结果</Text>;
    }
    default:
      return <Text type="secondary">{TASK_EVENT_LABELS[event.type] ?? event.type}</Text>;
  }
}

function EventBody({ event }: { event: TaskEvent }): ReactNode {
  const payload = payloadOf(event);

  switch (event.type) {
    case "agent.message": {
      const text = stringValue(payload, "text");
      if (text === undefined || text.trim().length === 0) {
        return <Text type="secondary">（空消息）</Text>;
      }
      return (
        <div style={{ fontSize: 13, lineHeight: 1.65, overflowWrap: "anywhere" }}>
          <ReactMarkdown
            components={{
              p: ({ children }) => <p style={{ margin: "4px 0" }}>{children}</p>,
              pre: ({ children }) => <pre style={PREVIEW_STYLE}>{children}</pre>,
              a: ({ children, href }) => (
                <a href={href} target="_blank" rel="noreferrer">
                  {children}
                </a>
              ),
            }}
          >
            {text}
          </ReactMarkdown>
        </div>
      );
    }
    case "agent.tool_call": {
      const tool = stringValue(payload, "tool") ?? "(unknown)";
      const args = stringValue(payload, "args_preview");
      return (
        <Space direction="vertical" size={2} style={{ width: "100%" }}>
          <Space size={8} wrap>
            <Text type="secondary">工具</Text>
            <Text code>{tool}</Text>
          </Space>
          {args === undefined || args.length === 0 ? null : <pre style={PREVIEW_STYLE}>{args}</pre>}
        </Space>
      );
    }
    case "agent.tool_result": {
      const ok = payload.ok === true;
      const ms = numberValue(payload, "ms");
      const preview = stringValue(payload, "preview");
      const code = stringValue(payload, "code");
      return (
        <Space direction="vertical" size={2} style={{ width: "100%" }}>
          <Space size={8} wrap>
            <Tag color={ok ? "success" : "error"} style={{ marginInlineEnd: 0 }}>
              {ok ? "成功" : "失败"}
            </Tag>
            {ms === undefined ? null : <Text type="secondary">{ms}ms</Text>}
            {code === undefined ? null : <Text code>{code}</Text>}
          </Space>
          {preview === undefined || preview.length === 0 ? null : (
            <pre style={PREVIEW_STYLE}>{preview}</pre>
          )}
        </Space>
      );
    }
    case "llm.call": {
      const model = stringValue(payload, "model") ?? "model";
      const inTokens = numberValue(payload, "in") ?? 0;
      const cached = numberValue(payload, "cached") ?? 0;
      const outTokens = numberValue(payload, "out") ?? 0;
      const ms = numberValue(payload, "ms");
      return (
        <Space size={10} wrap>
          <Text code>{model}</Text>
          <Text>输入 {inTokens}</Text>
          {cached > 0 ? (
            <Tag color="green" style={{ marginInlineEnd: 0 }}>
              缓存命中 {cached}
            </Tag>
          ) : (
            <Text type="secondary">缓存 0</Text>
          )}
          <Text>输出 {outTokens}</Text>
          {ms === undefined ? null : <Text type="secondary">{ms}ms</Text>}
        </Space>
      );
    }
    case "agent.step": {
      const step = numberValue(payload, "step_no");
      return <Text>第 {step ?? "?"} 步</Text>;
    }
    case "artifact.created": {
      const path = stringValue(payload, "path");
      const id = stringValue(payload, "artifact_id");
      return (
        <Space size={8} wrap>
          {id === undefined ? null : <Text code>{id}</Text>}
          {path === undefined ? null : <Text>{path}</Text>}
        </Space>
      );
    }
    case "summary.generated": {
      return <Text>{stringValue(payload, "summary") ?? "摘要已生成"}</Text>;
    }
    case "budget.warning": {
      const spent = numberValue(payload, "spent");
      const budget = numberValue(payload, "budget");
      return (
        <Text type="warning">
          预算告警：{spent ?? "?"} / {budget ?? "?"} tokens
        </Text>
      );
    }
    case "memory.fact_upserted": {
      const key = stringValue(payload, "key");
      const value = stringValue(payload, "value");
      return (
        <Space size={8} wrap>
          <Text code>{key ?? "fact"}</Text>
          <Text>{value ?? ""}</Text>
        </Space>
      );
    }
    default:
      if (event.type.startsWith("task.")) return taskEventSummary(event);
      return <Text type="secondary">事件已记录</Text>;
  }
}

function EventRow({ event }: { event: TaskEvent }) {
  const isTaskEvent = event.type.startsWith("task.");
  const color = EVENT_COLORS[event.type] ?? "default";
  const dotColor =
    event.type === "task.failed"
      ? "#cf1322"
      : event.type === "task.completed"
        ? "#389e0d"
        : isTaskEvent
          ? "#1677ff"
          : "#d9d9d9";

  return (
    <div style={isTaskEvent ? TASK_ROW_STYLE : ROW_STYLE}>
      <span
        aria-hidden
        style={{
          position: "absolute",
          left: 8,
          top: 18,
          width: isTaskEvent ? 9 : 7,
          height: isTaskEvent ? 9 : 7,
          borderRadius: "50%",
          background: dotColor,
          boxShadow: isTaskEvent ? `0 0 0 3px ${dotColor}22` : undefined,
        }}
      />
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 12,
        }}
      >
        <Space size={6} wrap>
          <Text type="secondary" style={{ fontFamily: "monospace", fontSize: 12 }}>
            #{event.seq}
          </Text>
          <Tag color={color} style={{ marginInlineEnd: 0 }}>
            {event.type}
          </Tag>
          <Tag style={{ marginInlineEnd: 0 }}>{ACTOR_LABELS[event.actor] ?? event.actor}</Tag>
        </Space>
        <Text type="secondary" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
          {formatTime(event.ts)}
        </Text>
      </div>

      <div style={{ marginTop: 6 }}>
        <EventBody event={event} />
      </div>

      <details style={{ marginTop: 6 }}>
        <summary style={{ cursor: "pointer", color: "#8c8c8c", fontSize: 12 }}>
          payload JSON
        </summary>
        <pre style={PREVIEW_STYLE}>{formatJson(event.payload)}</pre>
      </details>
    </div>
  );
}

export default function EventTimeline({ events, autoFollow, running }: EventTimelineProps) {
  const scrollParentRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);

  const virtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: () => 104,
    overscan: 8,
    getItemKey: (index) => events[index]?.seq ?? index,
  });

  const scrollToBottom = useCallback((): void => {
    if (events.length === 0) return;
    virtualizer.scrollToIndex(events.length - 1, { align: "end" });
  }, [events.length, virtualizer]);

  // 只在“用户没往上翻”时跟随；新事件到来时不打断阅读。
  useEffect(() => {
    if (!autoFollow || !atBottomRef.current || events.length === 0) return;
    const frame = window.requestAnimationFrame(scrollToBottom);
    return () => window.cancelAnimationFrame(frame);
  }, [autoFollow, events.length, scrollToBottom]);

  // 开关重新打开时立即回到底部。
  useEffect(() => {
    if (!autoFollow) return;
    atBottomRef.current = true;
    const frame = window.requestAnimationFrame(scrollToBottom);
    return () => window.cancelAnimationFrame(frame);
  }, [autoFollow, scrollToBottom]);

  // 动态行高测量后总高度会变化，仍贴底时再校正一次。
  const totalSize = virtualizer.getTotalSize();
  useEffect(() => {
    if (!autoFollow || !atBottomRef.current || events.length === 0) return;
    const frame = window.requestAnimationFrame(scrollToBottom);
    return () => window.cancelAnimationFrame(frame);
  }, [autoFollow, events.length, scrollToBottom, totalSize]);

  const handleScroll = (event: UIEvent<HTMLDivElement>): void => {
    const element = event.currentTarget;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    atBottomRef.current = distance <= 48;
  };

  return (
    <Space direction="vertical" size={8} style={{ width: "100%" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
        }}
      >
        <Text strong>执行时间线</Text>
        <Space size={8}>
          {running ? (
            <Tag color="processing" style={{ marginInlineEnd: 0 }}>
              实时接收中
            </Tag>
          ) : null}
          <Text type="secondary" style={{ fontSize: 12 }}>
            共 {events.length} 条 · 虚拟滚动仅渲染可视行
          </Text>
        </Space>
      </div>

      <div
        ref={scrollParentRef}
        onScroll={handleScroll}
        style={{
          height: "calc(100vh - 500px)",
          minHeight: 300,
          overflowY: "auto",
          overflowX: "hidden",
          border: "1px solid #f0f0f0",
          borderRadius: 8,
          background: "#fcfcfc",
          padding: "12px 14px",
          contain: "strict",
        }}
      >
        {events.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="还没有事件；任务启动后会在这里实时出现。"
            style={{ marginTop: 80 }}
          />
        ) : (
          <div
            style={{
              height: virtualizer.getTotalSize(),
              width: "100%",
              position: "relative",
            }}
          >
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const event = events[virtualItem.index];
              if (event === undefined) return null;
              return (
                <div
                  key={virtualItem.key}
                  data-index={virtualItem.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualItem.start}px)`,
                    paddingBottom: 8,
                  }}
                >
                  <EventRow event={event} />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Space>
  );
}
