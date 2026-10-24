/**
 * 产物库（M6-03）：搜索 + 结果卡片 + 详情抽屉。
 *
 * 列表只展示 title / summary / tags / trust / 来源任务 / 时间；点开卡片后
 * 才 GET /artifacts/:id 拉单产物详情。正文落盘是 M7-01 的事，本页不读取正文。
 */
import { useCallback, useRef, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Drawer,
  Empty,
  Input,
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
  searchArtifacts,
  type Artifact,
  type ArtifactHit,
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
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ArtifactHit[]>([]);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<Artifact | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  /** 防止快速点开另一张卡片时，先发出的详情响应覆盖后选的卡片。 */
  const detailRequestRef = useRef(0);

  const runSearch = useCallback(async (raw: string): Promise<void> => {
    setLoading(true);
    setError(null);
    setSearched(true);
    try {
      setResults(await searchArtifacts(raw, 30));
    } catch (searchError) {
      setResults([]);
      setError(searchError instanceof Error ? searchError.message : String(searchError));
    } finally {
      setLoading(false);
    }
  }, []);

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

  return (
    <>
      <PageHeader
        eyebrow="Artifacts"
        title="产物库"
        subtitle="按关键词检索产物摘要、标签与发现；点卡片查看详情。"
      />

      <div className="artifact-search">
        <Input
          size="large"
          allowClear
          prefix={<SearchOutlined />}
          value={query}
          placeholder="输入关键词，例如：月度分析、环比、CSV"
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
            message="产物检索失败"
            description={error}
            action={
              <Button
                size="small"
                onClick={() => {
                  void runSearch(query);
                }}
              >
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
              <span>检索中…</span>
            </Space>
          </div>
        ) : error !== null ? null : !searched ? (
          <EmptyState
            icon={<FolderOpenOutlined />}
            title="开始检索产物"
            description="输入关键词后回车或点「搜索」，从摘要、标签与发现中查找产物。"
          />
        ) : results.length === 0 ? (
          <EmptyState
            icon={<SearchOutlined />}
            title="没有匹配的产物"
            description={`没有命中「${query.trim()}」的产物，换个关键词试试。`}
          />
        ) : (
          <div className="artifact-grid">
            {results.map((artifact) => (
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
            ))}
          </div>
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
