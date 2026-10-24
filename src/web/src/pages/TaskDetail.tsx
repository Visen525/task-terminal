/**
 * 任务详情页（M6-02）：任务头部 + 虚拟化执行时间线。
 *
 * 事件加载/SSE/合批全部在 useTaskEvents；本页只负责组装、取消/重试动作和
 * “自动跟随底部”开关。
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Alert, App as AntdApp, Button, Empty, Space, Spin } from "antd";

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
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
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
        />
      )}

      {task === undefined ? (
        isLoading ? (
          <Space size={10} style={{ padding: 32 }}>
            <Spin />
            <span>加载任务与历史事件…</span>
          </Space>
        ) : error === null ? (
          <Empty description="任务不存在或尚未加载完成" style={{ marginTop: 80 }} />
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
    </Space>
  );
}
