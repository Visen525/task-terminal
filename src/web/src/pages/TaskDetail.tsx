/**
 * 任务详情页（M6-02）：任务头部 + 虚拟化执行时间线。
 *
 * 事件加载/SSE/合批全部在 useTaskEvents；本页只负责组装、取消/重试动作和
 * “自动跟随底部”开关。
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Alert, App as AntdApp, Button, Spin } from "antd";
import { ProfileOutlined } from "@ant-design/icons";

import EmptyState from "../components/EmptyState";
import EventTimeline from "../components/EventTimeline";
import TaskHeader from "../components/TaskHeader";
import { useTaskEvents } from "../hooks/useTaskEvents";
import { cancelTask, retryTask } from "../taskActions";

interface TaskDetailProps {
  taskId: string;
  onBack: () => void;
}

export default function TaskDetail({ taskId, onBack }: TaskDetailProps) {
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();
  const [autoFollow, setAutoFollow] = useState(true);
  const { task, events, isLoading, error, sseStatus, refetch } = useTaskEvents(taskId);

  const refreshAfterAction = async (): Promise<void> => {
    await refetch();
    await queryClient.invalidateQueries({ queryKey: ["tasks"] });
  };

  const cancelMutation = useMutation({
    mutationFn: () => cancelTask(taskId),
    onSuccess: async () => {
      message.success("任务已取消");
      await refreshAfterAction();
    },
    onError: (mutationError) => {
      message.error(mutationError.message);
    },
  });

  const retryMutation = useMutation({
    mutationFn: () => retryTask(taskId),
    onSuccess: async () => {
      message.success("任务已重新入队");
      await refreshAfterAction();
    },
    onError: (mutationError) => {
      message.error(mutationError.message);
    },
  });

  const actionPending = cancelMutation.isPending || retryMutation.isPending;

  return (
    <div style={{ width: "100%" }}>
      {error === null ? null : (
        <Alert
          type="error"
          showIcon
          message="任务详情加载失败"
          description={error.message}
          action={
            <Button
              size="small"
              onClick={() => {
                void refetch();
              }}
            >
              重试
            </Button>
          }
          style={{ marginBottom: 16 }}
        />
      )}

      {task === undefined ? (
        isLoading ? (
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              gap: 12,
              padding: "72px 0",
              color: "var(--tt-text-secondary)",
            }}
          >
            <Spin size="large" />
            <span>加载任务与历史事件…</span>
          </div>
        ) : error === null ? (
          <EmptyState
            icon={<ProfileOutlined />}
            title="任务不存在或尚未加载完成"
            description="请返回看板重新选择一条任务。"
            action={<Button onClick={onBack}>返回任务看板</Button>}
          />
        ) : null
      ) : (
        <>
          <TaskHeader
            task={task}
            events={events}
            sseStatus={sseStatus}
            autoFollow={autoFollow}
            onAutoFollowChange={setAutoFollow}
            onBack={onBack}
            onCancel={() => {
              cancelMutation.mutate();
            }}
            onRetry={() => {
              retryMutation.mutate();
            }}
            actionPending={actionPending}
          />
          <EventTimeline
            events={events}
            autoFollow={autoFollow}
            running={task.status === "running"}
          />
        </>
      )}
    </div>
  );
}
