import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Space, Spin, Typography } from "antd";

import { getTaskDetail } from "../api";

interface TaskDetailProps {
  taskId: string;
  onBack: () => void;
}

export default function TaskDetail({ taskId, onBack }: TaskDetailProps) {
  const detailQuery = useQuery({
    queryKey: ["task", taskId],
    queryFn: () => getTaskDetail(taskId),
  });

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 16,
        }}
      >
        <div>
          <Typography.Title level={3} style={{ margin: 0 }}>
            任务详情
          </Typography.Title>
          <Typography.Text code>{taskId}</Typography.Text>
        </div>
        <Button onClick={onBack}>返回任务看板</Button>
      </div>

      <Typography.Text type="secondary">
        M6-02 将把这里替换为执行时间线；当前为占位页，直接展示 GET /tasks/:id 的 JSON。
      </Typography.Text>

      {detailQuery.isLoading ? <Spin /> : null}

      {detailQuery.isError ? (
        <Alert
          type="error"
          showIcon
          message="任务详情加载失败"
          description={detailQuery.error?.message ?? "未知错误"}
          action={
            <Button
              size="small"
              onClick={() => {
                void detailQuery.refetch();
              }}
            >
              重试
            </Button>
          }
        />
      ) : null}

      {detailQuery.data === undefined ? null : (
        <pre
          style={{
            margin: 0,
            padding: 16,
            background: "#fafafa",
            border: "1px solid #f0f0f0",
            borderRadius: 6,
            maxHeight: "calc(100vh - 260px)",
            overflow: "auto",
            fontSize: 12,
            lineHeight: 1.6,
          }}
        >
          {JSON.stringify(detailQuery.data, null, 2)}
        </pre>
      )}
    </Space>
  );
}
