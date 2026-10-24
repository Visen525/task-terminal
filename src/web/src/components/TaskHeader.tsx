/**
 * 任务详情头部（M6-02）：状态、目标、耗时、token 累计、预算进度与操作按钮。
 */
import { useEffect, useState, type ReactNode } from "react";
import { Button, Progress, Space, Spin, Switch, Tag, Tooltip, Typography } from "antd";

import type { Task, TaskEvent, TaskStatus } from "../api";
import type { SseStatus } from "../hooks/useTaskEvents";

const { Text, Paragraph, Title } = Typography;

interface StatusMeta {
  label: string;
  color: string;
  spinning: boolean;
}

const STATUS_META: Record<TaskStatus, StatusMeta> = {
  queued: { label: "排队中", color: "default", spinning: false },
  running: { label: "执行中", color: "processing", spinning: true },
  completed: { label: "已完成", color: "success", spinning: false },
  failed: { label: "失败", color: "error", spinning: false },
  waiting_input: { label: "等待输入", color: "warning", spinning: false },
  cancelled: { label: "已取消", color: "default", spinning: false },
};

const SSE_META: Record<SseStatus, { label: string; color: string }> = {
  connecting: { label: "连接中", color: "default" },
  open: { label: "实时已连接", color: "success" },
  reconnecting: { label: "断线重连中", color: "warning" },
  closed: { label: "连接已关闭", color: "default" },
};

const NUMBER_FORMATTER = new Intl.NumberFormat("zh-CN");
const DATE_TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

interface TokenTotals {
  input: number;
  cached: number;
  output: number;
  calls: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function sumLlmTokens(events: TaskEvent[]): TokenTotals {
  const totals: TokenTotals = { input: 0, cached: 0, output: 0, calls: 0 };
  for (const event of events) {
    if (event.type !== "llm.call" || !isRecord(event.payload)) continue;
    totals.input += numberValue(event.payload, "in");
    totals.cached += numberValue(event.payload, "cached");
    totals.output += numberValue(event.payload, "out");
    totals.calls += 1;
  }
  return totals;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatTime(timestamp: number | null): string {
  return timestamp === null ? "—" : DATE_TIME_FORMATTER.format(new Date(timestamp));
}

function StatusTag({ status }: { status: TaskStatus }) {
  const meta = STATUS_META[status];
  return (
    <Tag
      color={meta.color}
      icon={meta.spinning ? <Spin size="small" /> : undefined}
      style={{ marginInlineEnd: 0 }}
    >
      {meta.label}
    </Tag>
  );
}

interface MetaItemProps {
  label: string;
  children: ReactNode;
}

function MetaItem({ label, children }: MetaItemProps) {
  return (
    <Space direction="vertical" size={0}>
      <Text type="secondary" style={{ fontSize: 12 }}>
        {label}
      </Text>
      <div>{children}</div>
    </Space>
  );
}

interface TaskHeaderProps {
  task: Task;
  events: TaskEvent[];
  sseStatus: SseStatus;
  autoFollow: boolean;
  onAutoFollowChange: (value: boolean) => void;
  onBack: () => void;
  onCancel: () => void;
  onRetry: () => void;
  actionPending: boolean;
}

export default function TaskHeader({
  task,
  events,
  sseStatus,
  autoFollow,
  onAutoFollowChange,
  onBack,
  onCancel,
  onRetry,
  actionPending,
}: TaskHeaderProps) {
  const running = task.status === "running";
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  const totals = sumLlmTokens(events);
  const tokensFromEvents = totals.input + totals.output;
  const spent = Math.max(task.spentTokens, tokensFromEvents);
  const percent =
    task.budgetTokens > 0 ? Math.min(100, Math.round((spent / task.budgetTokens) * 1000) / 10) : 0;
  const progressColor = percent >= 90 ? "#cf1322" : percent >= 80 ? "#faad14" : "#52c41a";
  const elapsed =
    task.startedAt === null
      ? null
      : Math.max(0, (task.endedAt ?? (running ? now : Date.now())) - task.startedAt);
  const sse = SSE_META[sseStatus];

  return (
    <div
      style={{
        border: "1px solid #f0f0f0",
        borderRadius: 10,
        padding: 16,
        background: "#fff",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <Space size={10} wrap align="center">
            <Title level={3} style={{ margin: 0 }}>
              {task.title}
            </Title>
            <StatusTag status={task.status} />
            <Tag color={sse.color} style={{ marginInlineEnd: 0 }}>
              {sse.label}
            </Tag>
            <Text type="secondary" copyable={{ text: task.id }} style={{ fontFamily: "monospace" }}>
              {task.id}
            </Text>
          </Space>
          <Paragraph
            type="secondary"
            style={{ margin: "10px 0 0", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
          >
            {task.goal}
          </Paragraph>
        </div>

        <Space wrap>
          {task.status === "failed" ? (
            <Button type="primary" loading={actionPending} onClick={onRetry}>
              重试任务
            </Button>
          ) : null}
          {running ? (
            <Tooltip title="中止执行；进程会由调度器杀干净并写入 task.cancelled">
              <Button danger loading={actionPending} onClick={onCancel}>
                取消任务
              </Button>
            </Tooltip>
          ) : null}
          <Button onClick={onBack}>返回任务看板</Button>
        </Space>
      </div>

      <div
        style={{
          display: "flex",
          gap: 28,
          flexWrap: "wrap",
          marginTop: 16,
          paddingTop: 14,
          borderTop: "1px solid #f5f5f5",
        }}
      >
        <MetaItem label="耗时">
          <Text>{elapsed === null ? "尚未开始" : formatDuration(elapsed)}</Text>
        </MetaItem>
        <MetaItem label={`LLM 调用 / token（${totals.calls} 次）`}>
          <Space size={10} wrap>
            <Text>输入 {NUMBER_FORMATTER.format(totals.input)}</Text>
            {totals.cached > 0 ? (
              <Tag color="green" style={{ marginInlineEnd: 0 }}>
                缓存命中 {NUMBER_FORMATTER.format(totals.cached)}
              </Tag>
            ) : null}
            <Text>输出 {NUMBER_FORMATTER.format(totals.output)}</Text>
            <Text type="secondary">合计 {NUMBER_FORMATTER.format(tokensFromEvents)}</Text>
          </Space>
        </MetaItem>
        <MetaItem label="创建 / 开始 / 结束">
          <Text type="secondary">
            {formatTime(task.createdAt)} / {formatTime(task.startedAt)} / {formatTime(task.endedAt)}
          </Text>
        </MetaItem>
        <div style={{ flex: "1 1 260px", minWidth: 220 }}>
          <Space size={8} style={{ width: "100%" }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              预算
            </Text>
            <Text style={{ fontSize: 12 }}>
              {NUMBER_FORMATTER.format(spent)} / {NUMBER_FORMATTER.format(task.budgetTokens)}
            </Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {percent}%
            </Text>
          </Space>
          <Progress
            percent={percent}
            showInfo={false}
            strokeColor={progressColor}
            size="small"
            style={{ margin: 0 }}
          />
        </div>
        {running ? (
          <MetaItem label="时间线跟随">
            <Space size={8}>
              <Spin size="small" />
              <Text style={{ fontSize: 12 }}>执行中</Text>
              <Switch
                size="small"
                checked={autoFollow}
                onChange={onAutoFollowChange}
                checkedChildren="自动"
                unCheckedChildren="手动"
              />
            </Space>
          </MetaItem>
        ) : null}
      </div>
    </div>
  );
}
