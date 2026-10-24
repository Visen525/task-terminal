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
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <div>
        <Typography.Title level={3} style={{ margin: 0 }}>
          产物库
        </Typography.Title>
        <Typography.Text type="secondary">
          按关键词检索产物摘要、标签与发现；点卡片查看详情。
        </Typography.Text>
      </div>

      <Space.Compact style={{ width: "100%", maxWidth: 680 }}>
        <Input
          allowClear
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
          type="primary"
          loading={loading}
          onClick={() => {
            void runSearch(query);
          }}
        >
          搜索
        </Button>
      </Space.Compact>

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
        />
      )}

      {loading ? (
        <Space size={10} style={{ padding: 24 }}>
          <Spin />
          <span>检索中…</span>
        </Space>
      ) : error !== null ? null : !searched ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="输入关键词后回车或点「搜索」，开始检索产物。"
          style={{ marginTop: 56 }}
        />
      ) : results.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={`没有命中「${query.trim()}」的产物。`}
          style={{ marginTop: 56 }}
        />
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
            gap: 16,
          }}
        >
          {results.map((artifact) => (
            <Card
              key={artifact.id}
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
              styles={{ body: { display: "flex", flexDirection: "column", gap: 8 } }}
            >
              <Typography.Paragraph
                type="secondary"
                ellipsis={{ rows: 3 }}
                style={{ marginBottom: 0, minHeight: 66 }}
              >
                {artifact.summary}
              </Typography.Paragraph>

              {artifact.tags.length > 0 ? (
                <Space size={[0, 4]} wrap>
                  {artifact.tags.map((tag) => (
                    <Tag key={tag} color="blue">
                      {tag}
                    </Tag>
                  ))}
                </Space>
              ) : (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  无标签
                </Typography.Text>
              )}

              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  来源任务{" "}
                  <Typography.Text code title={artifact.taskId}>
                    {shortId(artifact.taskId)}
                  </Typography.Text>
                </Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {formatTime(artifact.createdAt)}
                </Typography.Text>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Drawer
        title={selected === null ? "产物详情" : selected.title}
        open={drawerOpen}
        onClose={closeDrawer}
        width={560}
      >
        {detailLoading ? (
          <Space size={10} style={{ padding: 24 }}>
            <Spin />
            <span>加载产物详情…</span>
          </Space>
        ) : detailError !== null ? (
          <Alert type="error" showIcon message="产物详情加载失败" description={detailError} />
        ) : selected === null ? (
          <Empty description="请选择一条产物" />
        ) : (
          <Space direction="vertical" size={20} style={{ width: "100%" }}>
            <Space size={8} wrap>
              <TrustTag trust={selected.trust} />
              <Tag>{selected.kind}</Tag>
              <Typography.Text type="secondary">{formatTime(selected.createdAt)}</Typography.Text>
            </Space>

            <section>
              <Typography.Title level={5} style={{ marginTop: 0 }}>
                摘要
              </Typography.Title>
              <Typography.Paragraph style={{ whiteSpace: "pre-wrap", marginBottom: 0 }}>
                {selected.summary}
              </Typography.Paragraph>
            </section>

            <section>
              <Typography.Title level={5} style={{ marginTop: 0 }}>
                发现（findings）
              </Typography.Title>
              {selected.findings.length === 0 ? (
                <Typography.Text type="secondary">暂无</Typography.Text>
              ) : (
                <ul style={{ margin: 0, paddingInlineStart: 20 }}>
                  {selected.findings.map((finding, index) => (
                    <li key={`${String(index)}-${finding}`}>{finding}</li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <Typography.Title level={5} style={{ marginTop: 0 }}>
                标签
              </Typography.Title>
              {selected.tags.length === 0 ? (
                <Typography.Text type="secondary">无</Typography.Text>
              ) : (
                <Space size={[0, 4]} wrap>
                  {selected.tags.map((tag) => (
                    <Tag key={tag} color="blue">
                      {tag}
                    </Tag>
                  ))}
                </Space>
              )}
            </section>

            <section>
              <Typography.Title level={5} style={{ marginTop: 0 }}>
                来源任务
              </Typography.Title>
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
          </Space>
        )}
      </Drawer>
    </Space>
  );
}
