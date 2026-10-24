/**
 * 任务详情头部（M6-02）：状态、目标、耗时、token 累计、预算进度与操作按钮。
 *
 * M9-01 仅做视觉分组：目标 / token 与预算 / 时间线三张小卡。
 */
import { useEffect, useState } from "react";
import { Button, Progress, Spin, Switch, Tag, Tooltip, Typography } from "antd";
import { ArrowLeftOutlined } from "@ant-design/icons";

import type { Task, TaskEvent, TaskStatus } from "../api";
import type { SseStatus } from "../hooks/useTaskEvents";

const { Text } = Typography;

interface StatusMeta {
  label: string;
  color: string;
  background: string;
}

const STATUS_META: Record<TaskStatus, StatusMeta> = {
  queued: { label: "排队中", color: "#6B7280", background: "#F3F4F6" },
  running: { label: "执行中", color: "#4F46E5", background: "#EEF2FF" },
  completed: { label: "已完成", color: "#15803D", background: "#F0FDF4" },
  failed: { label: "失败", color: "#B91C1C", background: "#FEF2F2" },
  waiting_input: { label: "等待输入", color: "#B45309", background: "#FFFBEB" },
  cancelled: { label: "已取消", color: "#6B7280", background: "#F3F4F6" },
};

const SSE_META: Record<SseStatus, StatusMeta> = {
  connecting: { label: "连接中", color: "#6B7280", background: "#F3F4F6" },
  open: { label: "实时已连接", color: "#15803D", background: "#F0FDF4" },
  reconnecting: { label: "断线重连中", color: "#B45309", background: "#FFFBEB" },
  closed: { label: "连接已关闭", color: "#6B7280", background: "#F3F4F6" },
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
      style={{
        marginInlineEnd: 0,
        border: "none",
        background: meta.background,
        color: meta.color,
        fontWeight: 500,
      }}
    >
      <span
        className={
          status === "running" ? "task-status-dot is-running" : "task-status-dot"
        }
        style={{ background: meta.color, marginInlineEnd: 6, verticalAlign: "middle" }}
      />
      {meta.label}
    </Tag>
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
  const progressColor = percent >= 90 ? "#DC2626" : percent >= 80 ? "#D97706" : "#4F46E5";
  const elapsed =
    task.startedAt === null
      ? null
      : Math.max(0, (task.endedAt ?? (running ? now : Date.now())) - task.startedAt);
  const sse = SSE_META[sseStatus];

  return (
    <div>
      <div className="detail-topbar">
        <Button
          type="text"
          className="detail-back"
          icon={<ArrowLeftOutlined />}
          onClick={onBack}
        >
          任务看板
        </Button>
        <div className="detail-top-actions">
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
        </div>
      </div>

      <div className="detail-headline">
        <div className="detail-title-block">
          <h1 className="detail-title">{task.title}</h1>
          <div className="detail-subline">
            <StatusTag status={task.status} />
            <Tag
              style={{
                marginInlineEnd: 0,
                border: "none",
                background: sse.background,
                color: sse.color,
                fontWeight: 500,
              }}
            >
              {sse.label}
            </Tag>
            <Text
              className="detail-id"
              copyable={{ text: task.id, tooltips: ["复制任务 ID", "已复制"] }}
            >
              {task.id}
            </Text>
          </div>
        </div>
      </div>

      <div className="detail-grid">
        <div className="info-panel info-panel-wide">
          <span className="info-label">状态与目标</span>
          <p className="detail-goal" style={{ margin: 0 }}>
            {task.goal}
          </p>
        </div>

        <div className="info-panel">
          <span className="info-label">Token 与预算</span>
          <div className="token-row">
            <span>
              输入 <strong>{NUMBER_FORMATTER.format(totals.input)}</strong>
            </span>
            {totals.cached > 0 ? (
              <Tag color="green" style={{ marginInlineEnd: 0 }}>
                缓存命中 {NUMBER_FORMATTER.format(totals.cached)}
              </Tag>
            ) : (
              <span className="token-muted">缓存 0</span>
            )}
            <span>
              输出 <strong>{NUMBER_FORMATTER.format(totals.output)}</strong>
            </span>
            <span className="token-muted">
              合计 {NUMBER_FORMATTER.format(tokensFromEvents)} · {totals.calls} 次调用
            </span>
          </div>

          <div className="budget-line">
            <div className="budget-top">
              <span>
                预算 {NUMBER_FORMATTER.format(spent)} / {NUMBER_FORMATTER.format(task.budgetTokens)}
              </span>
              <span>{percent}%</span>
            </div>
            <Progress
              percent={percent}
              showInfo={false}
              strokeColor={progressColor}
              size="small"
              style={{ margin: 0 }}
            />
          </div>

        </div>

        <div className="info-panel">
          <span className="info-label">时间线</span>
          <div className="timeline-meta-list">
            <div className="timeline-meta-row">
              <span className="meta-key">耗时</span>
              <span className="meta-value">
                {elapsed === null ? "尚未开始" : formatDuration(elapsed)}
              </span>
            </div>
            <div className="timeline-meta-row">
              <span className="meta-key">创建</span>
              <span className="meta-value">{formatTime(task.createdAt)}</span>
            </div>
            <div className="timeline-meta-row">
              <span className="meta-key">开始</span>
              <span className="meta-value">{formatTime(task.startedAt)}</span>
            </div>
            <div className="timeline-meta-row">
              <span className="meta-key">结束</span>
              <span className="meta-value">{formatTime(task.endedAt)}</span>
            </div>
          </div>
          {running ? (
            <div style={{ marginTop: 14 }}>
              <span className="info-label" style={{ marginBottom: 6 }}>
                时间线跟随
              </span>
              <div className="follow-switch">
                <Spin size="small" />
                <span>执行中</span>
                <Switch
                  size="small"
                  checked={autoFollow}
                  onChange={onAutoFollowChange}
                  checkedChildren="自动"
                  unCheckedChildren="手动"
                />
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
