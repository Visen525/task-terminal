/**
 * 产物库（M11-03）：默认浏览全部产物 + kind 筛选 + 服务端分页，搜索是可选过滤。
 *
 * 卡片只展示 title / summary / tags / trust / 来源任务 / 时间；点开卡片后
 * 才 GET /artifacts/:id 拉单产物详情。正文落盘是 M7-01 的事，本页不读取正文。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Drawer,
  Empty,
  Input,
  Pagination,
  Segmented,
  Space,
  Spin,
  Tag,
  Typography,
} from "antd";
import { FolderOpenOutlined, SearchOutlined } from "@ant-design/icons";

import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";
import {
  getArtifact,
  listArtifacts,
  searchArtifacts,
  type Artifact,
  type ArtifactBrowseResult,
  type ArtifactHit,
  type ArtifactKind,
  type ArtifactMode,
  type ArtifactSearchResult,
  type ArtifactTrust,
} from "../artifactApi";

interface ArtifactsProps {
  /** 跳任务详情（由 App 的极简路由提供）。 */
  onOpenTask: (taskId: string) => void;
}

interface TrustMeta {
  label: string;
  color: string;
}

const TRUST_META: Record<ArtifactTrust, TrustMeta> = {
  unverified: { label: "未验证", color: "default" },
  verified: { label: "已验证", color: "success" },
  failed: { label: "验证失败", color: "error" },
};

const PAGE_SIZE = 24;

type KindFilter = ArtifactKind | "all";

const KIND_OPTIONS: Array<{ value: KindFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "file", label: "文件" },
  { value: "note", label: "笔记" },
  { value: "dataset", label: "数据集" },
  { value: "patch", label: "补丁" },
];

const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatTime(timestamp: number): string {
  return dateTimeFormatter.format(new Date(timestamp));
}

function shortId(id: string): string {
  return id.length <= 16 ? id : `${id.slice(0, 8)}…${id.slice(-6)}`;
}

function TrustTag({ trust }: { trust: ArtifactTrust }) {
  const meta = TRUST_META[trust];
  return (
    <Tag color={meta.color} style={{ marginInlineEnd: 0 }}>
      {meta.label}
    </Tag>
  );
}

export default function Artifacts({ onOpenTask }: ArtifactsProps) {
  /** 单一模式开关：browse=默认全量浏览，search=带 query 的检索结果。 */
  const [mode, setMode] = useState<ArtifactMode>("browse");
  const [query, setQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [page, setPage] = useState(1);

  const [browse, setBrowse] = useState<ArtifactBrowseResult | null>(null);
  const [search, setSearch] = useState<ArtifactSearchResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [selected, setSelected] = useState<Artifact | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  /** 防止快速点开另一张卡片时，先发出的详情响应覆盖后选的卡片。 */
  const detailRequestRef = useRef(0);
  /** 浏览/搜索各自用递增请求号丢弃过期响应，避免模式切换时串台。 */
  const browseRequestRef = useRef(0);
  const searchRequestRef = useRef(0);

  useEffect(() => {
    if (mode !== "browse") return;
    const requestId = browseRequestRef.current + 1;
    browseRequestRef.current = requestId;
    setLoading(true);
    setError(null);

    const offset = (page - 1) * PAGE_SIZE;
    listArtifacts({
      limit: PAGE_SIZE,
      offset,
      ...(kind === "all" ? {} : { kind }),
    })
      .then((result) => {
        if (browseRequestRef.current !== requestId) return;
        setBrowse(result);
      })
      .catch((loadError: unknown) => {
        if (browseRequestRef.current !== requestId) return;
        setBrowse(null);
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      })
      .finally(() => {
        if (browseRequestRef.current === requestId) setLoading(false);
      });
  }, [mode, kind, page, reloadToken]);

  const backToBrowse = useCallback((): void => {
    // 取消可能仍在途的搜索响应；切回浏览时 effect 会重新拉全量。
    searchRequestRef.current += 1;
    setMode("browse");
    setActiveQuery("");
    setQuery("");
    setKind("all");
    setPage(1);
    setError(null);
    setReloadToken((token) => token + 1);
  }, []);

  const runSearch = useCallback(async (raw: string): Promise<void> => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      backToBrowse();
      return;
    }

    // 丢弃在途的浏览响应，避免它把 loading 提前关掉。
    browseRequestRef.current += 1;
    const requestId = searchRequestRef.current + 1;
    searchRequestRef.current = requestId;
    setMode("search");
    setActiveQuery(trimmed);
    setLoading(true);
    setError(null);
    try {
      const result = await searchArtifacts(trimmed, 50);
      if (searchRequestRef.current === requestId) setSearch(result);
    } catch (searchError) {
      if (searchRequestRef.current !== requestId) return;
      setSearch(null);
      setError(searchError instanceof Error ? searchError.message : String(searchError));
    } finally {
      if (searchRequestRef.current === requestId) setLoading(false);
    }
  }, [backToBrowse]);

  const openDetail = useCallback(async (hit: Artifact): Promise<void> => {
    const requestId = detailRequestRef.current + 1;
    detailRequestRef.current = requestId;
    setSelected(hit);
    setDrawerOpen(true);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const detail = await getArtifact(hit.id);
      if (detailRequestRef.current === requestId) setSelected(detail);
    } catch (detailLoadError) {
      if (detailRequestRef.current === requestId) {
        // 已有列表命中数据，详情拉取失败时保留卡片内容并提示。
        setDetailError(
          detailLoadError instanceof Error ? detailLoadError.message : String(detailLoadError),
        );
      }
    } finally {
      if (detailRequestRef.current === requestId) setDetailLoading(false);
    }
  }, []);

  const closeDrawer = (): void => {
    detailRequestRef.current += 1;
    setDrawerOpen(false);
    setDetailError(null);
  };

  const retry = (): void => {
    if (mode === "search") {
      void runSearch(activeQuery);
    } else {
      setReloadToken((token) => token + 1);
    }
  };

  const items: Artifact[] =
    mode === "browse" ? (browse?.items ?? []) : (search?.items ?? []);
  const total = mode === "browse" ? (browse?.total ?? 0) : (search?.total ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const cards = items.map((artifact: Artifact) => (
    <Card
      key={artifact.id}
      className="artifact-card"
      hoverable
      onClick={() => {
        void openDetail(artifact);
      }}
      extra={<TrustTag trust={artifact.trust} />}
      title={
        <Typography.Text strong ellipsis={{ tooltip: artifact.title }}>
          {artifact.title}
        </Typography.Text>
      }
      styles={{ body: { display: "flex", flexDirection: "column", gap: 10 } }}
    >
      <Typography.Paragraph
        type="secondary"
        ellipsis={{ rows: 3 }}
        className="artifact-summary"
      >
        {artifact.summary}
      </Typography.Paragraph>

      {artifact.tags.length > 0 ? (
        <Space size={[0, 6]} wrap>
          {artifact.tags.map((tag) => (
            <Tag key={tag} className="soft-tag">
              {tag}
            </Tag>
          ))}
        </Space>
      ) : (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          无标签
        </Typography.Text>
      )}

      <div className="artifact-footer">
        <span>
          来源任务{" "}
          <Typography.Text code title={artifact.taskId}>
            {shortId(artifact.taskId)}
          </Typography.Text>
        </span>
        <span>{formatTime(artifact.createdAt)}</span>
      </div>
    </Card>
  ));

  return (
    <>
      <PageHeader
        eyebrow="Artifacts"
        title="产物库"
        subtitle="浏览全部产物并按类型筛选；需要时再用关键词搜索。"
      />

      <div className="artifact-search">
        <Input
          size="large"
          allowClear
          prefix={<SearchOutlined />}
          value={query}
          placeholder="搜索产物（留空即浏览全部）"
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          onPressEnter={() => {
            void runSearch(query);
          }}
        />
        <Button
          className="search-button"
          size="large"
          type="primary"
          icon={<SearchOutlined />}
          loading={loading}
          onClick={() => {
            void runSearch(query);
          }}
        >
          搜索
        </Button>
      </div>

      <div style={{ marginTop: 20 }}>
        {error === null ? null : (
          <Alert
            type="error"
            showIcon
            message={mode === "search" ? "产物检索失败" : "产物加载失败"}
            description={error}
            action={
              <Button size="small" onClick={retry}>
                重试
              </Button>
            }
            style={{ marginBottom: 16 }}
          />
        )}

        {loading ? (
          <div style={{ display: "flex", justifyContent: "center", padding: "72px 0" }}>
            <Space size={10} style={{ color: "var(--tt-text-secondary)" }}>
              <Spin />
              <span>{mode === "search" ? "检索中…" : "加载产物…"}</span>
            </Space>
          </div>
        ) : error !== null ? null : mode === "search" ? (
          <>
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                flexWrap: "wrap",
                marginBottom: 16,
                padding: "3px 6px 3px 12px",
                border: "1px solid var(--tt-border)",
                borderRadius: 999,
                background: "var(--tt-surface)",
                fontSize: 13,
                color: "var(--tt-text-secondary)",
              }}
            >
              <span>
                搜索 “{activeQuery}” · {total} 条
              </span>
              <Button type="link" size="small" onClick={backToBrowse}>
                清除，返回全部
              </Button>
            </div>

            {items.length === 0 ? (
              <EmptyState
                icon={<SearchOutlined />}
                title="没有匹配的产物"
                description={`没有命中「${activeQuery}」的产物，换个关键词试试，或清除搜索查看全部。`}
              />
            ) : (
              <div className="artifact-grid">{cards}</div>
            )}
          </>
        ) : (
          <>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                flexWrap: "wrap",
                marginBottom: 16,
              }}
            >
              <Segmented
                value={kind}
                options={KIND_OPTIONS}
                onChange={(value) => {
                  const next =
                    KIND_OPTIONS.find((option) => option.value === value)?.value ?? "all";
                  setKind(next);
                  setPage(1);
                }}
              />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                共 {total} 个产物
              </Typography.Text>
            </div>

            {items.length === 0 ? (
              <EmptyState
                icon={<FolderOpenOutlined />}
                title={kind === "all" ? "还没有产物" : "该类型下暂无产物"}
                description={
                  kind === "all"
                    ? "任务产出的文件与结论会沉淀在这里。"
                    : "换个类型筛选，或切回「全部」查看所有产物。"
                }
              />
            ) : (
              <>
                <div className="artifact-grid">{cards}</div>

                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                    flexWrap: "wrap",
                    marginTop: 20,
                    fontSize: 12,
                    color: "var(--tt-text-tertiary)",
                  }}
                >
                  <span>
                    第 {page} / {totalPages} 页 · 共 {total} 条
                  </span>
                  <Pagination
                    size="small"
                    current={page}
                    pageSize={PAGE_SIZE}
                    total={total}
                    showSizeChanger={false}
                    onChange={setPage}
                  />
                </div>
              </>
            )}
          </>
        )}
      </div>

      <Drawer
        title={selected === null ? "产物详情" : selected.title}
        open={drawerOpen}
        onClose={closeDrawer}
        width={560}
        styles={{ body: { paddingTop: 20 } }}
      >
        {detailLoading ? (
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              gap: 10,
              padding: "48px 0",
              color: "var(--tt-text-secondary)",
            }}
          >
            <Spin />
            <span>加载产物详情…</span>
          </div>
        ) : detailError !== null ? (
          <Alert type="error" showIcon message="产物详情加载失败" description={detailError} />
        ) : selected === null ? (
          <Empty description="请选择一条产物" />
        ) : (
          <div className="drawer-stack">
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <TrustTag trust={selected.trust} />
              <Tag className="soft-tag">{selected.kind}</Tag>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {formatTime(selected.createdAt)}
              </Typography.Text>
            </div>

            <section>
              <h3 className="drawer-section-title">摘要</h3>
              <p className="drawer-summary">{selected.summary}</p>
            </section>

            <section>
              <h3 className="drawer-section-title">发现（findings）</h3>
              {selected.findings.length === 0 ? (
                <Typography.Text type="secondary">暂无</Typography.Text>
              ) : (
                <ul className="drawer-list">
                  {selected.findings.map((finding, index) => (
                    <li key={`${String(index)}-${finding}`}>{finding}</li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h3 className="drawer-section-title">标签</h3>
              {selected.tags.length === 0 ? (
                <Typography.Text type="secondary">无</Typography.Text>
              ) : (
                <Space size={[0, 6]} wrap>
                  {selected.tags.map((tag) => (
                    <Tag key={tag} className="soft-tag">
                      {tag}
                    </Tag>
                  ))}
                </Space>
              )}
            </section>

            <section>
              <h3 className="drawer-section-title">来源任务</h3>
              <Button
                type="link"
                style={{ paddingInline: 0 }}
                onClick={() => {
                  const taskId = selected.taskId;
                  closeDrawer();
                  onOpenTask(taskId);
                }}
              >
                查看任务 {selected.taskId}
              </Button>
            </section>
          </div>
        )}
      </Drawer>
    </>
  );
}
