/**
 * 设置面板（M9-02）：模型与预算概览、长期记忆管理、全库统计。
 *
 * 入口是侧边栏底部的齿轮；本页只走相对路径请求 /settings/overview 与 /facts，
 * 不直接接触数据库。长期记忆默认只看当前有效版本，打开开关后追加显示被取代的
 * 历史版本；删除统一走 DELETE /facts/:id，成功后失效 facts 与 overview 两个查询。
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App as AntdApp,
  Button,
  Popconfirm,
  Progress,
  Spin,
  Statistic,
  Switch,
  Tag,
  Typography,
} from "antd";
import {
  DatabaseOutlined,
  DeleteOutlined,
  LinkOutlined,
  ReloadOutlined,
} from "@ant-design/icons";

import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";

const NUMBER_FORMATTER = new Intl.NumberFormat("zh-CN");
const DATE_TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

interface TodayUsage {
  input: number;
  cached: number;
  output: number;
  total: number;
}

interface SettingsOverview {
  model: string;
  dailyBudgetTokens: number;
  todayUsage: TodayUsage;
  counts: {
    tasks: number;
    artifacts: number;
    facts: number;
  };
}

/** GET /facts 的直通行：字段保持仓储层 snake_case。 */
interface FactRecord {
  id: string;
  key: string;
  value: string;
  confidence: number;
  scope: string;
  source_task_id: string | null;
  created_at: number;
  updated_at: number;
  superseded_by: string | null;
}

interface SettingsProps {
  /** 跳到任务详情（由 App 的极简路由提供）。 */
  onOpenTask: (taskId: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
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
  return fallback;
}

async function requestJson(path: string, method: "GET" | "DELETE" = "GET"): Promise<unknown> {
  const response = await fetch(path, {
    method,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  return (await response.json()) as unknown;
}

async function getSettingsOverview(): Promise<SettingsOverview> {
  const body = await requestJson("/settings/overview");
  if (
    !isRecord(body) ||
    typeof body.model !== "string" ||
    !isFiniteNumber(body.dailyBudgetTokens) ||
    !isRecord(body.todayUsage) ||
    !isFiniteNumber(body.todayUsage.input) ||
    !isFiniteNumber(body.todayUsage.cached) ||
    !isFiniteNumber(body.todayUsage.output) ||
    !isFiniteNumber(body.todayUsage.total) ||
    !isRecord(body.counts) ||
    !isFiniteNumber(body.counts.tasks) ||
    !isFiniteNumber(body.counts.artifacts) ||
    !isFiniteNumber(body.counts.facts)
  ) {
    throw new Error("GET /settings/overview 返回格式不合法");
  }
  return body as unknown as SettingsOverview;
}

async function getFacts(includeSuperseded: boolean): Promise<FactRecord[]> {
  const params = new URLSearchParams();
  params.set("includeSuperseded", includeSuperseded ? "true" : "false");
  const body = await requestJson(`/facts?${params.toString()}`);
  if (!Array.isArray(body)) {
    throw new Error("GET /facts 返回格式不合法");
  }
  return body as FactRecord[];
}

async function deleteFact(id: string): Promise<{ deleted: number }> {
  const body = await requestJson(`/facts/${encodeURIComponent(id)}`, "DELETE");
  if (!isRecord(body) || !isFiniteNumber(body.deleted)) {
    throw new Error("DELETE /facts/:id 返回格式不合法");
  }
  return { deleted: body.deleted };
}

function formatNumber(value: number): string {
  return NUMBER_FORMATTER.format(value);
}

function formatTime(timestamp: number): string {
  return DATE_TIME_FORMATTER.format(new Date(timestamp));
}

function shortId(id: string): string {
  return id.length <= 16 ? id : `${id.slice(0, 8)}…${id.slice(-6)}`;
}

/** SQLite 中 confidence 是 0–1 的小数；展示时夹紧到 0–100%。 */
function confidencePercent(confidence: number): number {
  if (!Number.isFinite(confidence)) return 0;
  const clamped = Math.min(1, Math.max(0, confidence));
  return Math.round(clamped * 1000) / 10;
}

function LoadingPanel({ text }: { text: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        padding: "44px 0",
        background: "var(--tt-surface)",
        border: "1px solid var(--tt-border)",
        borderRadius: "var(--tt-radius-lg)",
        color: "var(--tt-text-secondary)",
      }}
    >
      <Spin />
      <span>{text}</span>
    </div>
  );
}

interface FactCardProps {
  fact: FactRecord;
  historical: boolean;
  deleting: boolean;
  onDelete: () => void;
  onOpenTask: (taskId: string) => void;
}

function FactCard({ fact, historical, deleting, onDelete, onOpenTask }: FactCardProps) {
  const sourceTaskId = fact.source_task_id;
  const percent = confidencePercent(fact.confidence);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: 16,
        padding: 16,
        background: historical ? "#F9FAFB" : "var(--tt-surface)",
        border: `1px solid ${historical ? "#F1F5F9" : "var(--tt-border)"}`,
        borderRadius: "var(--tt-radius-lg)",
        opacity: historical ? 0.72 : 1,
        transition: "border-color 0.18s ease, box-shadow 0.18s ease",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Typography.Text strong style={{ fontSize: 15, overflowWrap: "anywhere" }}>
            {fact.key}
          </Typography.Text>
          <Tag className="soft-tag">{fact.scope}</Tag>
          {historical ? <Tag>已被取代</Tag> : null}
        </div>

        <p
          style={{
            margin: "8px 0 12px",
            fontSize: 13.5,
            lineHeight: 1.7,
            color: "#4B5563",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          {fact.value}
        </p>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            flexWrap: "wrap",
            fontSize: 12,
            color: "var(--tt-text-tertiary)",
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
            置信度
            <Progress
              percent={percent}
              showInfo={false}
              size="small"
              strokeColor={historical ? "#9CA3AF" : "#4F46E5"}
              style={{ width: 88, margin: 0 }}
            />
            <span style={{ fontVariantNumeric: "tabular-nums" }}>{percent}%</span>
          </span>

          {sourceTaskId === null ? (
            <span>无来源任务</span>
          ) : (
            <Button
              type="link"
              size="small"
              icon={<LinkOutlined />}
              style={{ paddingInline: 0, height: "auto", fontSize: 12 }}
              title={sourceTaskId}
              onClick={() => {
                onOpenTask(sourceTaskId);
              }}
            >
              来源任务 {shortId(sourceTaskId)}
            </Button>
          )}

          <span>更新于 {formatTime(fact.updated_at)}</span>
        </div>
      </div>

      <Popconfirm
        title="删除这条长期记忆？"
        description={
          historical
            ? "这是被取代的历史版本，删除后无法恢复。"
            : "删除后无法恢复；指向它的取代链会自动断开。"
        }
        okText="删除"
        cancelText="取消"
        okButtonProps={{ danger: true, loading: deleting }}
        onConfirm={onDelete}
      >
        <Button
          type="text"
          danger
          icon={<DeleteOutlined />}
          aria-label={`删除记忆 ${fact.key}`}
          loading={deleting}
        />
      </Popconfirm>
    </div>
  );
}

export default function Settings({ onOpenTask }: SettingsProps) {
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();
  const [includeSuperseded, setIncludeSuperseded] = useState(false);

  const overviewQuery = useQuery({
    queryKey: ["settings", "overview"],
    queryFn: getSettingsOverview,
  });
  const factsQuery = useQuery({
    queryKey: ["settings", "facts", includeSuperseded],
    queryFn: () => getFacts(includeSuperseded),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteFact(id),
    onSuccess: async (result) => {
      if (result.deleted === 0) {
        message.warning("这条记忆已不存在");
      } else {
        message.success("已删除这条记忆");
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["settings", "facts"] }),
        queryClient.invalidateQueries({ queryKey: ["settings", "overview"] }),
      ]);
    },
    onError: (error: Error) => {
      message.error(error.message);
    },
  });

  const overview = overviewQuery.data;
  const facts = factsQuery.data ?? [];
  const currentFacts = useMemo(
    () => facts.filter((fact) => fact.superseded_by === null),
    [facts],
  );
  const historicalFacts = useMemo(
    () => facts.filter((fact) => fact.superseded_by !== null),
    [facts],
  );

  const refreshAll = (): void => {
    void overviewQuery.refetch();
    void factsQuery.refetch();
  };

  const usage = overview?.todayUsage;
  const dailyPercent =
    usage === undefined || overview === undefined || overview.dailyBudgetTokens <= 0
      ? 0
      : Math.min(100, Math.round((usage.total / overview.dailyBudgetTokens) * 1000) / 10);
  const budgetColor = dailyPercent >= 90 ? "#DC2626" : dailyPercent >= 80 ? "#D97706" : "#4F46E5";

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="设置"
        subtitle="查看主 AI 的模型与今日预算，管理它记住的长期事实。"
        extra={
          <Button
            icon={<ReloadOutlined />}
            loading={overviewQuery.isFetching || factsQuery.isFetching}
            onClick={refreshAll}
          >
            刷新
          </Button>
        }
      />

      {overviewQuery.error === null ? null : (
        <Alert
          type="error"
          showIcon
          message="设置概览加载失败"
          description={overviewQuery.error.message}
          action={
            <Button
              size="small"
              onClick={() => {
                void overviewQuery.refetch();
              }}
            >
              重试
            </Button>
          }
          style={{ marginBottom: 16 }}
        />
      )}

      <section style={{ marginBottom: 28 }}>
        <div className="section-heading">
          <h2 className="section-title">模型与预算</h2>
          <span className="section-hint">本地时间今日 00:00 起 · 缓存命中不重复计入合计</span>
        </div>

        {overviewQuery.isLoading ? (
          <LoadingPanel text="加载模型与预算…" />
        ) : overview === undefined || usage === undefined ? null : (
          <div className="info-panel">
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <div>
                <span className="info-label">当前模型</span>
                <Typography.Text strong style={{ fontSize: 16 }}>
                  {overview.model}
                </Typography.Text>
              </div>
              <Tag className="soft-tag" style={{ marginInlineEnd: 0 }}>
                主线模型
              </Tag>
            </div>

            <div className="token-row" style={{ marginTop: 16 }}>
              <span>
                输入 <strong>{formatNumber(usage.input)}</strong>
              </span>
              <span>
                缓存命中 <strong>{formatNumber(usage.cached)}</strong>
              </span>
              <span>
                输出 <strong>{formatNumber(usage.output)}</strong>
              </span>
              <span>
                合计 <strong>{formatNumber(usage.total)}</strong>
              </span>
            </div>

            <div className="budget-line">
              <div className="budget-top">
                <span>
                  日预算 {formatNumber(usage.total)} / {formatNumber(overview.dailyBudgetTokens)}
                </span>
                <span>{dailyPercent}%</span>
              </div>
              <Progress
                percent={dailyPercent}
                showInfo={false}
                strokeColor={budgetColor}
                size="small"
                style={{ margin: 0 }}
              />
            </div>
          </div>
        )}
      </section>

      <section>
        <div className="section-heading">
          <h2 className="section-title">长期记忆</h2>
          <div className="follow-switch">
            <Switch
              size="small"
              checked={includeSuperseded}
              onChange={(checked) => {
                setIncludeSuperseded(checked);
              }}
            />
            <span>显示被取代的历史版本</span>
          </div>
        </div>

        {factsQuery.error === null ? null : (
          <Alert
            type="error"
            showIcon
            message="长期记忆加载失败"
            description={factsQuery.error.message}
            action={
              <Button
                size="small"
                onClick={() => {
                  void factsQuery.refetch();
                }}
              >
                重试
              </Button>
            }
            style={{ marginBottom: 16 }}
          />
        )}

        {factsQuery.isLoading ? (
          <LoadingPanel text="加载长期记忆…" />
        ) : factsQuery.error !== null ? null : facts.length === 0 ? (
          <EmptyState
            icon={<DatabaseOutlined />}
            title="主 AI 还没有记住任何事。"
            description={'对话里说"记住…"即可写入。'}
          />
        ) : (
          <>
            {currentFacts.length === 0 ? (
              <Typography.Text type="secondary">
                当前没有有效版本，以下是被取代的历史记录。
              </Typography.Text>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {currentFacts.map((fact) => (
                  <FactCard
                    key={fact.id}
                    fact={fact}
                    historical={false}
                    deleting={
                      deleteMutation.isPending && deleteMutation.variables === fact.id
                    }
                    onDelete={() => {
                      deleteMutation.mutate(fact.id);
                    }}
                    onOpenTask={onOpenTask}
                  />
                ))}
              </div>
            )}

            {includeSuperseded && historicalFacts.length > 0 ? (
              <div style={{ marginTop: 20 }}>
                <div className="section-heading" style={{ marginBottom: 10 }}>
                  <h3
                    className="section-title"
                    style={{ fontSize: 13, fontWeight: 600, color: "var(--tt-text-secondary)" }}
                  >
                    被取代的历史版本（{historicalFacts.length}）
                  </h3>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {historicalFacts.map((fact) => (
                    <FactCard
                      key={fact.id}
                      fact={fact}
                      historical
                      deleting={
                        deleteMutation.isPending && deleteMutation.variables === fact.id
                      }
                      onDelete={() => {
                        deleteMutation.mutate(fact.id);
                      }}
                      onOpenTask={onOpenTask}
                    />
                  ))}
                </div>
              </div>
            ) : null}
          </>
        )}
      </section>

      <section style={{ marginTop: 28 }}>
        <div className="section-heading">
          <h2 className="section-title">统计</h2>
          <span className="section-hint">全库累计</span>
        </div>

        {overviewQuery.isLoading ? (
          <LoadingPanel text="加载统计…" />
        ) : overview === undefined ? null : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 16,
            }}
          >
            <div className="info-panel">
              <span className="info-label">任务</span>
              <Statistic
                value={overview.counts.tasks}
                valueStyle={{ fontSize: 24, fontWeight: 650, color: "#111827" }}
              />
            </div>
            <div className="info-panel">
              <span className="info-label">产物</span>
              <Statistic
                value={overview.counts.artifacts}
                valueStyle={{ fontSize: 24, fontWeight: 650, color: "#111827" }}
              />
            </div>
            <div className="info-panel">
              <span className="info-label">事实</span>
              <Statistic
                value={overview.counts.facts}
                valueStyle={{ fontSize: 24, fontWeight: 650, color: "#111827" }}
              />
            </div>
          </div>
        )}
      </section>
    </>
  );
}
