/**
 * 设置面板（M10-02）：模型与思考、权限、工作空间、日预算、长期记忆与统计。
 *
 * 设置读写走 settingsApi.ts 的 GET/PUT /settings；PUT 的 400 字段错误按
 * `字段路径 + 说明` 拆开后回填到对应控件下方。记忆与统计仍是 M9-02 的行为：
 * 默认只看当前有效版本，打开开关后追加历史版本，删除成功同时失效 facts/overview。
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Input,
  InputNumber,
  Popconfirm,
  Progress,
  Radio,
  Segmented,
  Select,
  Slider,
  Spin,
  Statistic,
  Switch,
  Tag,
  Typography,
} from "antd";
import {
  CheckCircleOutlined,
  ClearOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  FolderOpenOutlined,
  InfoCircleOutlined,
  KeyOutlined,
  LinkOutlined,
  ReloadOutlined,
  SaveOutlined,
} from "@ant-design/icons";

import type { PermissionMode } from "../api";
import DirectoryBrowserModal from "../components/DirectoryBrowser";
import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";
import {
  checkApiKey,
  getSettings,
  parseSettingsFieldErrors,
  putSettings,
  type ApiKeyBalance,
  type ApiKeyCheckResult,
  type AppSettings,
  type RoleModelSettings,
  type SubagentSettings,
  type ThinkingLevel,
} from "../settingsApi";

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

const CUSTOM_MODEL = "__custom__";
const MODEL_OPTIONS = [
  { value: "deepseek-chat", label: "deepseek-chat", title: "均衡默认" },
  { value: "deepseek-flash", label: "deepseek-flash", title: "快速经济" },
  {
    value: "deepseek-reasoner",
    label: "deepseek-reasoner",
    title: "深度思考更耗 token",
  },
  {
    value: "deepseek-v4-pro",
    label: "deepseek-v4-pro",
    title: "旗舰（账号实测可用）",
  },
  { value: CUSTOM_MODEL, label: "自定义…", title: "手动输入模型名" },
];
const KNOWN_MODELS = new Set(["deepseek-chat", "deepseek-flash", "deepseek-reasoner", "deepseek-v4-pro"]);

/**
 * 与后端 src/agent/main-loop.ts 的 MAIN_SYSTEM_PROMPT 保持逐字一致（M10-05）。
 * 未自定义时用它预填，让用户能直接看到内置规则；保存仍提交 null。
 */
const BUILTIN_MAIN_SYSTEM_PROMPT = [
  "你是「任务终端」的主线 AI：用户的本地任务台总控，负责理解需求、派活、跟进、验收与汇报。",
  "## 使命",
  "你是用户与执行体系之间的唯一接口。凡需要动手的工作（读写文件、运行命令、联网搜索、分析数据），都由你调用 create_task 派给子智能体执行；你不直接执行任何文件或命令操作。你的职责：把目标写清楚、跟进进度、核验产物、向用户汇报。",
  "## 你可以使用的工具",
  "- create_task：派活。把完整目标写进 goal；创建后子智能体会自动执行，成果进入产物库。创建后向用户转述任务 ID。",
  "- get_task：查询任务实时进度（progress）。用户问进展时调用并照实转述，不要编造。",
  "- list_tasks：查看任务看板，掌握当前所有任务与状态。",
  "- cancel_task：停止一个正在运行的任务。",
  "- retry_task：重试一个失败的任务。",
  "- search_artifacts：按关键词检索产物摘要。回答与历史工作有关的问题前先检索。",
  "- read_artifact：读取产物正文原文。需要细节或要下结论时用它核对。",
  "- remember：把值得长期记住的事实（用户偏好、项目背景等）写入记忆。",
  "- recall：检索长期记忆。",
  "- ask_user：意图不明或缺少关键信息时直接向用户提问，不要猜。",
  "## 每轮自动注入的上下文",
  "- 长期记忆摘要、任务看板概览、与用户消息相关的产物摘要（标题/摘要/标签，非全文）。",
  "- 「对话记忆（早期摘要）」：更早对话的滚动摘要；它只是索引，细节用 search_artifacts/recall 核实。",
  "- 历史里的 [图片 …] / [附件 …] 标记表示该内容当轮已真实送达并被你查看过（回放不重发本体）；基于它的当时回答继续有效，不要因为现在看不到原图就否认或撤回当时的结论。",
  "## 汇报与引用（硬规则）",
  "1. 汇报任务结果只引用【产物摘要】；需要细节先 search_artifacts 再 read_artifact。",
  "2. 引用任何产物结论时，必须同时给出来源任务 ID（source_task_id）；未经 read_artifact 核对的，注明\"根据摘要\"。",
  "3. 主动引用产物：回答涉及历史工作、任务成果或文件内容时，指出对应产物（标题 + ID），让用户能直接在产物库打开核对，不要等用户追问出处。",
  "4. 摘要不等于事实：宁可多读一次原文，也不要把摘要当结论。",
  "5. 用户询问任务进展/进度/执行到哪了时，调用 get_task 并转述 progress（第几步/共几步、正在执行的工具、已耗时、token 消耗占预算），不要编造未在 progress 里的细节。",
  "## 对话约定",
  "- 用中文；先给结论，再给必要细节；简洁但有信息量。",
  "- 需要动手就派任务，不空谈；任务创建后告诉用户任务 ID，并说明可在任务页看实时进度。",
  "- 需要用户做选择时，用 A. B. C. … 的格式每行一项列出，用户会点选。",
  "- 子智能体失败时如实汇报原因，并给出建议（重试、取消或调整目标重派）。",
  "- 不向用户索要敏感信息；对话与任务记录都会保存在本地数据库。",
].join("\n");

const MAIN_SYSTEM_PROMPT_HELP =
  "提示词决定主 AI 的行为规则；清空并保存即恢复内置默认。删掉关键规则（如必须 create_task、引用来源）可能让它越权或失忆，改动请谨慎。";

const THINKING_OPTIONS: Array<{ label: string; value: ThinkingLevel }> = [
  { label: "关闭", value: "off" },
  { label: "低", value: "low" },
  { label: "中", value: "medium" },
  { label: "高", value: "high" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isThinkingLevel(value: string): value is ThinkingLevel {
  return value === "off" || value === "low" || value === "medium" || value === "high";
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "read-only" || value === "workspace-write";
}

function cloneAppSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    main: { ...settings.main },
    subagent: { ...settings.subagent },
  };
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

/** 余额明细优先展示总额；没有返回值时退回可用状态。 */
function formatApiKeyBalance(balance: ApiKeyBalance): string {
  const entries = balance.balances
    .filter((item) => item.totalBalance.trim().length > 0)
    .map((item) => `${item.currency.length > 0 ? item.currency : "CNY"} ${item.totalBalance}`);
  if (entries.length > 0) return entries.join(" · ");
  return balance.isAvailable ? "账户可用（接口未返回余额明细）" : "账户当前不可用";
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

type SubagentLimitValues = Pick<
  SubagentSettings,
  "budgetTokens" | "maxSteps" | "wallMinutes"
>;

interface RoleCardProps {
  role: "main" | "subagent";
  title: string;
  badge: string;
  value: RoleModelSettings;
  errors: Record<string, string>;
  onChange: (patch: Partial<RoleModelSettings>) => void;
  /** 仅子代理卡片提供：任务级预算与步数/墙钟上限（M11-02）。 */
  limits?: {
    value: SubagentLimitValues;
    onChange: (patch: Partial<SubagentLimitValues>) => void;
  };
}

/** 主 AI / 子智能体各一张并列卡片；字段错误以 `main.xxx` / `subagent.xxx` 定位。 */
function RoleCard({ role, title, badge, value, errors, onChange, limits }: RoleCardProps) {
  const [customModel, setCustomModel] = useState(() => !KNOWN_MODELS.has(value.model));

  useEffect(() => {
    setCustomModel(!KNOWN_MODELS.has(value.model));
  }, [value.model]);

  const errorFor = (field: string): string | undefined => errors[`${role}.${field}`];
  const modelError = errorFor("model");
  const thinkingError = errorFor("thinkingLevel");
  const temperatureError = errorFor("temperature");
  const topPError = errorFor("topP");
  const maxTokensError = errorFor("maxTokens");
  const budgetTokensError = errorFor("budgetTokens");
  const maxStepsError = errorFor("maxSteps");
  const wallMinutesError = errorFor("wallMinutes");
  const reasoner = value.model.includes("reasoner");

  return (
    <Card
      className="settings-card"
      title={
        <span className="settings-role-title">
          <span className="settings-role-title-text">{title}</span>
          <Tag className="soft-tag">{badge}</Tag>
        </span>
      }
    >
      <div className="settings-field">
        <div className="settings-field-head">
          <span className="settings-field-label">模型</span>
        </div>
        <Select
          className="settings-model-select"
          value={customModel ? CUSTOM_MODEL : value.model}
          options={MODEL_OPTIONS}
          onChange={(next) => {
            if (next === CUSTOM_MODEL) {
              setCustomModel(true);
              return;
            }
            setCustomModel(false);
            onChange({ model: next });
          }}
        />
        {customModel ? (
          <Input
            value={value.model}
            maxLength={60}
            placeholder="输入模型名，例如 deepseek-chat"
            aria-label={`${title}自定义模型`}
            onChange={(event) => {
              onChange({ model: event.target.value });
            }}
          />
        ) : null}
        {modelError === undefined ? null : (
          <span className="settings-field-error">{modelError}</span>
        )}
      </div>

      <div className="settings-field">
        <div className="settings-field-head">
          <span className="settings-field-label">思考等级</span>
        </div>
        <Segmented
          value={value.thinkingLevel}
          options={THINKING_OPTIONS}
          onChange={(next) => {
            if (typeof next === "string" && isThinkingLevel(next)) {
              onChange({ thinkingLevel: next });
            }
          }}
        />
        <span className="settings-field-help">
          等级越高思考越充分，但会消耗更多 token
          {reasoner ? "；reasoner 模型本身消耗更高。" : "。"}
        </span>
        {thinkingError === undefined ? null : (
          <span className="settings-field-error">{thinkingError}</span>
        )}
      </div>

      <div className="settings-field">
        <div className="settings-field-head">
          <span className="settings-field-label">温度</span>
          <span className="settings-field-value">{value.temperature.toFixed(1)}</span>
        </div>
        <div className="settings-slider-row">
          <Slider
            min={0}
            max={2}
            step={0.1}
            value={value.temperature}
            onChange={(next) => {
              if (typeof next === "number") {
                onChange({ temperature: Math.round(next * 10) / 10 });
              }
            }}
          />
          <InputNumber
            min={0}
            max={2}
            step={0.1}
            precision={1}
            value={value.temperature}
            aria-label={`${title}温度`}
            onChange={(next) => {
              if (typeof next === "number") onChange({ temperature: next });
            }}
          />
        </div>
        <span className="settings-field-help">越低越稳定，越高越发散；范围 0–2。</span>
        {temperatureError === undefined ? null : (
          <span className="settings-field-error">{temperatureError}</span>
        )}
      </div>

      <div className="settings-field">
        <div className="settings-field-head">
          <span className="settings-field-label">top_p</span>
          <span className="settings-field-value">{value.topP.toFixed(2)}</span>
        </div>
        <div className="settings-slider-row">
          <Slider
            min={0}
            max={1}
            step={0.05}
            value={value.topP}
            onChange={(next) => {
              if (typeof next === "number") {
                onChange({ topP: Math.round(next * 100) / 100 });
              }
            }}
          />
          <InputNumber
            min={0}
            max={1}
            step={0.05}
            precision={2}
            value={value.topP}
            aria-label={`${title}top_p`}
            onChange={(next) => {
              if (typeof next === "number") onChange({ topP: next });
            }}
          />
        </div>
        <span className="settings-field-help">核采样范围 0–1，默认 1。</span>
        {topPError === undefined ? null : <span className="settings-field-error">{topPError}</span>}
      </div>

      <div className="settings-field" style={{ marginBottom: limits === undefined ? 0 : undefined }}>
        <div className="settings-field-head">
          <span className="settings-field-label">单轮输出上限</span>
        </div>
        <InputNumber
          min={256}
          max={8192}
          step={256}
          precision={0}
          value={value.maxTokens}
          addonAfter="tokens"
          aria-label={`${title}单轮输出上限`}
          style={{ width: 200 }}
          onChange={(next) => {
            if (typeof next === "number") onChange({ maxTokens: next });
          }}
        />
        <span className="settings-field-help">256–8192 tokens。</span>
        {maxTokensError === undefined ? null : (
          <span className="settings-field-error">{maxTokensError}</span>
        )}
      </div>

      {role === "subagent" && limits !== undefined ? (
        <>
          <div className="settings-field">
            <div className="settings-field-head">
              <span className="settings-field-label">任务 token 预算</span>
            </div>
            <InputNumber
              min={0}
              max={2_000_000}
              step={10_000}
              precision={0}
              value={limits.value.budgetTokens === 0 ? null : limits.value.budgetTokens}
              placeholder="不限"
              addonAfter="tokens"
              aria-label={`${title}任务 token 预算`}
              style={{ width: 220 }}
              onChange={(next) => {
                limits.onChange({ budgetTokens: typeof next === "number" ? next : 0 });
              }}
            />
            <span className="settings-field-help">0=不限；日预算仍全局生效。</span>
            {budgetTokensError === undefined ? null : (
              <span className="settings-field-error">{budgetTokensError}</span>
            )}
          </div>

          <div className="settings-field">
            <div className="settings-field-head">
              <span className="settings-field-label">最大步数</span>
            </div>
            <InputNumber
              min={1}
              max={500}
              step={10}
              precision={0}
              value={limits.value.maxSteps}
              addonAfter="步"
              aria-label={`${title}最大步数`}
              style={{ width: 200 }}
              onChange={(next) => {
                if (typeof next === "number") limits.onChange({ maxSteps: next });
              }}
            />
            <span className="settings-field-help">1–500；默认 120 步。</span>
            {maxStepsError === undefined ? null : (
              <span className="settings-field-error">{maxStepsError}</span>
            )}
          </div>

          <div className="settings-field" style={{ marginBottom: 0 }}>
            <div className="settings-field-head">
              <span className="settings-field-label">墙钟（分钟）</span>
            </div>
            <InputNumber
              min={1}
              max={240}
              step={5}
              precision={0}
              value={limits.value.wallMinutes}
              addonAfter="分钟"
              aria-label={`${title}墙钟上限`}
              style={{ width: 200 }}
              onChange={(next) => {
                if (typeof next === "number") limits.onChange({ wallMinutes: next });
              }}
            />
            <span className="settings-field-help">1–240；默认 60，到点中止任务。</span>
            {wallMinutesError === undefined ? null : (
              <span className="settings-field-error">{wallMinutesError}</span>
            )}
          </div>
        </>
      ) : null}
    </Card>
  );
}

interface PermissionCardProps {
  label: string;
  description: string;
  value: PermissionMode;
  error?: string | undefined;
  onChange: (value: PermissionMode) => void;
}

function PermissionCard({ label, description, value, error, onChange }: PermissionCardProps) {
  return (
    <div className="info-panel settings-permission-card">
      <span className="info-label">{label}</span>
      <Radio.Group
        value={value}
        onChange={(event) => {
          const next: unknown = event.target.value;
          if (isPermissionMode(next)) onChange(next);
        }}
      >
        <div className="permission-option">
          <Radio value="read-only">只读</Radio>
          <p className="permission-option-desc">
            只能读取工作区文件，不能写入或执行会改文件的命令。
          </p>
        </div>
        <div className="permission-option">
          <Radio value="workspace-write">可写</Radio>
          <p className="permission-option-desc">可在工作区内写入文件、创建产物；越界仍会被拦截。</p>
        </div>
      </Radio.Group>
      <p className="settings-field-help">{description}</p>
      {error === undefined ? null : <span className="settings-field-error">{error}</span>}
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
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);
  const [keyCheck, setKeyCheck] = useState<ApiKeyCheckResult | null>(null);

  const overviewQuery = useQuery({
    queryKey: ["settings", "overview"],
    queryFn: getSettingsOverview,
  });
  const settingsQuery = useQuery({
    queryKey: ["settings", "current"],
    queryFn: getSettings,
  });
  const factsQuery = useQuery({
    queryKey: ["settings", "facts", includeSuperseded],
    queryFn: () => getFacts(includeSuperseded),
  });

  useEffect(() => {
    if (settingsQuery.data !== undefined) {
      setDraft(cloneAppSettings(settingsQuery.data));
    }
  }, [settingsQuery.data]);

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

  const saveMutation = useMutation({
    mutationFn: (settings: AppSettings) =>
      putSettings({
        workspaceDir: settings.workspaceDir,
        // 清空 textarea 也等于恢复内置默认：后端只接受 null 或非空字符串。
        mainSystemPrompt:
          settings.mainSystemPrompt === null || settings.mainSystemPrompt.trim().length === 0
            ? null
            : settings.mainSystemPrompt,
        main: settings.main,
        subagent: settings.subagent,
        mainTaskDefaultPermission: settings.mainTaskDefaultPermission,
        subagentPermissionCap: settings.subagentPermissionCap,
        dailyBudgetTokens: settings.dailyBudgetTokens,
      }),
    onSuccess: async (saved) => {
      setDraft(cloneAppSettings(saved));
      setFieldErrors({});
      setSaveError(null);
      message.success("设置已保存，下一轮对话/下一次任务生效");
      queryClient.setQueryData(["settings", "current"], saved);
      await queryClient.invalidateQueries({ queryKey: ["settings", "overview"] });
    },
    onError: (error: Error) => {
      const parsed = parseSettingsFieldErrors(error.message);
      setFieldErrors(parsed.fieldErrors);
      const hasFieldError = Object.keys(parsed.fieldErrors).length > 0;
      if (parsed.general.length > 0) {
        setSaveError(parsed.general.join("；"));
      } else if (!hasFieldError) {
        setSaveError(error.message);
      } else {
        setSaveError(null);
      }
    },
  });

  /**
   * API Key 单独走 PUT：GET 永远不回明文，所以不能放进 draft 一起提交。
   * 保存/清除成功即更新 ["settings","current"]，App 顶部横幅会立刻消失/出现。
   */
  const apiKeySaveMutation = useMutation({
    mutationFn: (apiKey: string) => putSettings({ apiKey }),
    onSuccess: (saved) => {
      setApiKeyInput("");
      setApiKeyError(null);
      setKeyCheck(null);
      queryClient.setQueryData(["settings", "current"], saved);
      message.success("API Key 已保存，立即生效");
      void queryClient.invalidateQueries({ queryKey: ["settings", "overview"] });
    },
    onError: (error: Error) => {
      const parsed = parseSettingsFieldErrors(error.message);
      setApiKeyError(parsed.fieldErrors.apiKey ?? error.message);
    },
  });

  const apiKeyClearMutation = useMutation({
    mutationFn: () => putSettings({ apiKey: null }),
    onSuccess: (saved) => {
      setKeyCheck(null);
      setApiKeyError(null);
      queryClient.setQueryData(["settings", "current"], saved);
      message.success("已清除界面 API Key，若 .env 有值将自动回退");
      void queryClient.invalidateQueries({ queryKey: ["settings", "overview"] });
    },
    onError: (error: Error) => {
      setApiKeyError(error.message);
    },
  });

  const keyCheckMutation = useMutation({
    mutationFn: () => checkApiKey(),
    onSuccess: (result) => {
      setKeyCheck(result);
    },
    onError: (error: Error) => {
      setKeyCheck({ ok: false, reason: error.message });
    },
  });

  const overview = overviewQuery.data;
  const facts = factsQuery.data ?? [];
  const currentFacts = useMemo(() => facts.filter((fact) => fact.superseded_by === null), [facts]);
  const historicalFacts = useMemo(
    () => facts.filter((fact) => fact.superseded_by !== null),
    [facts],
  );

  const refreshAll = (): void => {
    void settingsQuery.refetch();
    void overviewQuery.refetch();
    void factsQuery.refetch();
  };

  const updateDraft = (patch: Partial<AppSettings>): void => {
    setDraft((current) => (current === null ? current : { ...current, ...patch }));
  };

  const updateRole = (role: "main" | "subagent", patch: Partial<RoleModelSettings>): void => {
    setDraft((current) => {
      if (current === null) return current;
      if (role === "main") {
        return { ...current, main: { ...current.main, ...patch } };
      }
      return { ...current, subagent: { ...current.subagent, ...patch } };
    });
  };

  const updateSubagent = (patch: Partial<SubagentLimitValues>): void => {
    setDraft((current) =>
      current === null
        ? current
        : { ...current, subagent: { ...current.subagent, ...patch } },
    );
  };

  const usage = overview?.todayUsage;
  const dailyPercent =
    usage === undefined || overview === undefined || overview.dailyBudgetTokens <= 0
      ? 0
      : Math.min(100, Math.round((usage.total / overview.dailyBudgetTokens) * 1000) / 10);
  const budgetColor = dailyPercent >= 90 ? "#DC2626" : dailyPercent >= 80 ? "#D97706" : "#4F46E5";
  const customPrompt = draft !== null && draft.mainSystemPrompt !== null;

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="设置"
        subtitle="配置模型与思考、任务权限、工作空间和日预算；下方仍可管理长期记忆与查看统计。"
        extra={
          <>
            <Button
              icon={<ReloadOutlined />}
              loading={
                settingsQuery.isFetching || overviewQuery.isFetching || factsQuery.isFetching
              }
              onClick={refreshAll}
            >
              刷新
            </Button>
            <Button
              type="primary"
              icon={<SaveOutlined />}
              loading={saveMutation.isPending}
              disabled={draft === null}
              onClick={() => {
                if (draft !== null) saveMutation.mutate(draft);
              }}
            >
              保存设置
            </Button>
          </>
        }
      />

      <div className="settings-notice">
        <InfoCircleOutlined />
        <span>设置即时生效（下一轮对话/下一次任务），无需重启</span>
      </div>

      {saveError === null ? null : (
        <Alert
          type="error"
          showIcon
          message="设置保存失败"
          description={saveError}
          closable
          onClose={() => {
            setSaveError(null);
          }}
          style={{ marginBottom: 16 }}
        />
      )}

      {settingsQuery.error === null ? null : (
        <Alert
          type="error"
          showIcon
          message="设置加载失败"
          description={settingsQuery.error.message}
          action={
            <Button
              size="small"
              onClick={() => {
                void settingsQuery.refetch();
              }}
            >
              重试
            </Button>
          }
          style={{ marginBottom: 16 }}
        />
      )}

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

      {settingsQuery.isLoading ? (
        <LoadingPanel text="加载设置…" />
      ) : draft === null ? null : (
        <>
          <section style={{ marginBottom: 28 }}>
            <div className="section-heading">
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <h2 className="section-title">API Key</h2>
                <KeyOutlined style={{ color: "var(--tt-text-tertiary)" }} />
              </span>
              <span className="section-hint">保存后立即生效，无需重启</span>
            </div>
            <div className="info-panel">
              <div className="settings-field">
                <div className="settings-field-head">
                  <span className="settings-field-label">DeepSeek API Key</span>
                  <span className="settings-field-value">
                    {draft.hasApiKey ? (
                      <Tag color="green">
                        已配置 · 尾号 {draft.apiKeyTail ?? "----"} · 来源{" "}
                        {draft.apiKeySource === "settings" ? "界面" : ".env"}
                      </Tag>
                    ) : (
                      <Tag>未配置</Tag>
                    )}
                  </span>
                </div>

                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    flexWrap: "wrap",
                    alignItems: "center",
                  }}
                >
                  <Input.Password
                    value={apiKeyInput}
                    placeholder="sk-…（只保存在本地数据库）"
                    autoComplete="new-password"
                    maxLength={200}
                    aria-label="DeepSeek API Key"
                    style={{ maxWidth: 420, minWidth: 260 }}
                    onChange={(event) => {
                      setApiKeyInput(event.target.value);
                      setApiKeyError(null);
                    }}
                  />
                  <Button
                    type="primary"
                    icon={<SaveOutlined />}
                    loading={apiKeySaveMutation.isPending}
                    disabled={apiKeyInput.trim().length === 0}
                    onClick={() => {
                      apiKeySaveMutation.mutate(apiKeyInput.trim());
                    }}
                  >
                    保存 Key
                  </Button>
                  <Button
                    icon={<CheckCircleOutlined />}
                    loading={keyCheckMutation.isPending}
                    disabled={!draft.hasApiKey}
                    title={draft.hasApiKey ? undefined : "请先保存 API Key 再测试"}
                    onClick={() => {
                      keyCheckMutation.mutate();
                    }}
                  >
                    测试连接
                  </Button>
                  <Button
                    danger
                    icon={<ClearOutlined />}
                    loading={apiKeyClearMutation.isPending}
                    disabled={draft.apiKeySource !== "settings"}
                    onClick={() => {
                      apiKeyClearMutation.mutate();
                    }}
                  >
                    清除
                  </Button>
                </div>

                <span className="settings-field-help">
                  只回显尾号，GET /settings 不返回明文；未配置时对话与任务不可用。
                </span>
                {apiKeyError === null ? null : (
                  <span className="settings-field-error">{apiKeyError}</span>
                )}

                {keyCheck === null ? null : keyCheck.ok ? (
                  <Alert
                    style={{ marginTop: 12 }}
                    type={keyCheck.balance.isAvailable ? "success" : "warning"}
                    showIcon
                    closable
                    message={
                      keyCheck.balance.isAvailable ? "连接成功" : "连接成功，但账户当前不可用"
                    }
                    description={formatApiKeyBalance(keyCheck.balance)}
                    onClose={() => {
                      setKeyCheck(null);
                    }}
                  />
                ) : (
                  <Alert
                    style={{ marginTop: 12 }}
                    type="error"
                    showIcon
                    closable
                    message="连接测试失败"
                    description={keyCheck.reason}
                    onClose={() => {
                      setKeyCheck(null);
                    }}
                  />
                )}
              </div>
            </div>
          </section>

          <section style={{ marginBottom: 28 }}>
            <div className="section-heading">
              <h2 className="section-title">模型与思考</h2>
              <span className="section-hint">主 AI 与子智能体各自独立配置</span>
            </div>
            <div className="settings-role-grid">
              <RoleCard
                role="main"
                title="主 AI"
                badge="主线对话"
                value={draft.main}
                errors={fieldErrors}
                onChange={(patch) => {
                  updateRole("main", patch);
                }}
              />
              <RoleCard
                role="subagent"
                title="子智能体"
                badge="任务执行"
                value={draft.subagent}
                errors={fieldErrors}
                onChange={(patch) => {
                  updateRole("subagent", patch);
                }}
                limits={{
                  value: draft.subagent,
                  onChange: updateSubagent,
                }}
              />
            </div>
          </section>

          <section style={{ marginBottom: 28 }}>
            <div className="section-heading">
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <h2 className="section-title">系统提示词</h2>
                <Tag className="soft-tag">{customPrompt ? "已自定义" : "内置默认 · 未修改"}</Tag>
              </span>
              <Button
                size="small"
                icon={<ReloadOutlined />}
                disabled={!customPrompt}
                onClick={() => {
                  updateDraft({ mainSystemPrompt: null });
                  message.success("已恢复内置默认，点击「保存设置」生效");
                }}
              >
                恢复默认
              </Button>
            </div>
            <div className="info-panel">
              <div className="settings-field" style={{ marginBottom: 0 }}>
                <div className="settings-field-head">
                  <span className="settings-field-label">主线提示词</span>
                  <span className="settings-field-value">
                    {draft.mainSystemPrompt === null
                      ? "内置默认"
                      : `${draft.mainSystemPrompt.length} / 8000`}
                  </span>
                </div>
                <Input.TextArea
                  rows={8}
                  maxLength={8000}
                  value={draft.mainSystemPrompt ?? BUILTIN_MAIN_SYSTEM_PROMPT}
                  aria-label="主线系统提示词"
                  onChange={(event) => {
                    updateDraft({ mainSystemPrompt: event.target.value });
                  }}
                  style={{ fontFamily: "var(--tt-mono)", fontSize: 12.5, lineHeight: 1.7 }}
                />
                <span className="settings-field-help">{MAIN_SYSTEM_PROMPT_HELP}</span>
                {fieldErrors.mainSystemPrompt === undefined ? null : (
                  <span className="settings-field-error">{fieldErrors.mainSystemPrompt}</span>
                )}
              </div>
            </div>
          </section>

          <section style={{ marginBottom: 28 }}>
            <div className="section-heading">
              <h2 className="section-title">权限</h2>
              <span className="section-hint">只读 &lt; 可写；子代理上限会钳制所有任务</span>
            </div>
            <div className="settings-permission-grid">
              <PermissionCard
                label="主线派任务默认权限"
                description="主 AI 创建任务时，未指定权限就使用这一项。"
                value={draft.mainTaskDefaultPermission}
                error={fieldErrors.mainTaskDefaultPermission}
                onChange={(value) => {
                  updateDraft({ mainTaskDefaultPermission: value });
                }}
              />
              <PermissionCard
                label="子代理权限上限"
                description="选只读则所有任务强制只读；即使主 AI 请求可写也会被钳制。"
                value={draft.subagentPermissionCap}
                error={fieldErrors.subagentPermissionCap}
                onChange={(value) => {
                  updateDraft({ subagentPermissionCap: value });
                }}
              />
            </div>
          </section>

          <section style={{ marginBottom: 28 }}>
            <div className="section-heading">
              <h2 className="section-title">工作空间</h2>
              <span className="section-hint">任务默认在这个目录内执行</span>
            </div>
            <div className="info-panel settings-workspace">
              <div className="settings-workspace-row">
                <div className="settings-workspace-path">
                  <span className="info-label">当前路径</span>
                  <Typography.Text
                    code={draft.workspaceDir !== null}
                    className="settings-path"
                    copyable={draft.workspaceDir === null ? false : { text: draft.workspaceDir }}
                  >
                    {draft.workspaceDir ?? "尚未设置（使用默认工作区）"}
                  </Typography.Text>
                </div>
                <Button
                  icon={<FolderOpenOutlined />}
                  onClick={() => {
                    setBrowserOpen(true);
                  }}
                >
                  更改
                </Button>
              </div>
              <span className="settings-field-help">
                更改后点击保存即时生效；下一个任务会使用新目录。
              </span>
              {fieldErrors.workspaceDir === undefined ? null : (
                <span className="settings-field-error">{fieldErrors.workspaceDir}</span>
              )}
            </div>
          </section>

          <section style={{ marginBottom: 28 }}>
            <div className="section-heading">
              <h2 className="section-title">日预算</h2>
              <span className="section-hint">本地时间今日 00:00 起 · 缓存命中不重复计入合计</span>
            </div>
            <div className="info-panel">
              <div className="settings-budget-row">
                <div className="settings-budget-input">
                  <span className="info-label">每日 token 上限</span>
                  <InputNumber
                    min={50_000}
                    step={10_000}
                    precision={0}
                    value={draft.dailyBudgetTokens}
                    addonAfter="tokens"
                    aria-label="每日 token 上限"
                    style={{ width: 240 }}
                    onChange={(next) => {
                      if (typeof next === "number") {
                        updateDraft({ dailyBudgetTokens: next });
                      }
                    }}
                  />
                  <span className="settings-field-help">至少 50,000；达到后暂停派新任务。</span>
                  {fieldErrors.dailyBudgetTokens === undefined ? null : (
                    <span className="settings-field-error">{fieldErrors.dailyBudgetTokens}</span>
                  )}
                </div>

                <div className="settings-budget-usage">
                  {usage === undefined || overview === undefined ? (
                    <span className="settings-field-help">正在读取今日用量…</span>
                  ) : (
                    <>
                      <div className="token-row">
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
                            今日用量 {formatNumber(usage.total)} /{" "}
                            {formatNumber(overview.dailyBudgetTokens)}
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
                    </>
                  )}
                </div>
              </div>
            </div>
          </section>
        </>
      )}

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
                    deleting={deleteMutation.isPending && deleteMutation.variables === fact.id}
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
                      deleting={deleteMutation.isPending && deleteMutation.variables === fact.id}
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

      <DirectoryBrowserModal
        open={browserOpen}
        initialPath={draft?.workspaceDir ?? null}
        onClose={() => {
          setBrowserOpen(false);
        }}
        onConfirm={(path) => {
          setDraft((current) => (current === null ? current : { ...current, workspaceDir: path }));
          setFieldErrors((current) => {
            const next = { ...current };
            delete next.workspaceDir;
            return next;
          });
          setBrowserOpen(false);
          message.success("已回填工作空间，点击「保存设置」生效");
        }}
      />
    </>
  );
}
