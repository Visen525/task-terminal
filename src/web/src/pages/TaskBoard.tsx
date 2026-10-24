import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App as AntdApp,
  Button,
  Form,
  Input,
  Modal,
  Pagination,
  Select,
  Space,
  Spin,
} from "antd";
import {
  AppstoreOutlined,
  ClockCircleOutlined,
  FieldTimeOutlined,
  PlusOutlined,
  ReloadOutlined,
  RightOutlined,
} from "@ant-design/icons";

import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";
import {
  createTask,
  listTasks,
  type CreateTaskInput,
  type PermissionMode,
  type Task,
  type TaskStatus,
} from "../api";

interface TaskBoardProps {
  onOpenTask: (taskId: string) => void;
}

interface StatusMeta {
  label: string;
  color: string;
}

const STATUS_META: Record<TaskStatus, StatusMeta> = {
  queued: { label: "排队中", color: "#9CA3AF" },
  running: { label: "执行中", color: "#4F46E5" },
  completed: { label: "已完成", color: "#16A34A" },
  failed: { label: "失败", color: "#DC2626" },
  waiting_input: { label: "等待输入", color: "#D97706" },
  cancelled: { label: "已取消", color: "#9CA3AF" },
};

const PERMISSION_OPTIONS: Array<{ value: PermissionMode; label: string }> = [
  { value: "workspace-write", label: "workspace-write（可写工作区）" },
  { value: "read-only", label: "read-only（只读）" },
];

const PAGE_SIZE = 12;

const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function formatTime(timestamp: number | null): string {
  return timestamp === null ? "—" : dateTimeFormatter.format(new Date(timestamp));
}

function formatDuration(task: Task): string {
  if (task.startedAt === null) return "未开始";
  const end = task.endedAt ?? (task.status === "running" ? Date.now() : null);
  if (end === null) return "—";
  const ms = Math.max(0, end - task.startedAt);
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function shortId(id: string): string {
  return id.length <= 14 ? id : `${id.slice(0, 6)}…${id.slice(-6)}`;
}

export default function TaskBoard({ onOpenTask }: TaskBoardProps) {
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [form] = Form.useForm<CreateTaskInput>();

  const tasksQuery = useQuery({
    queryKey: ["tasks"],
    queryFn: listTasks,
    refetchInterval: 2000,
  });

  const createMutation = useMutation({
    mutationFn: (input: CreateTaskInput) => createTask(input),
    onSuccess: async () => {
      message.success("任务已创建");
      setModalOpen(false);
      form.resetFields();
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (error) => {
      message.error(error.message);
    },
  });

  const tasks = tasksQuery.data ?? [];
  const totalPages = Math.max(1, Math.ceil(tasks.length / PAGE_SIZE));

  // 刷新后任务数可能减少；把当前页收敛到有效范围。
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const pageTasks = tasks.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const openModal = (): void => {
    form.resetFields();
    setModalOpen(true);
  };

  const closeModal = (): void => {
    if (createMutation.isPending) return;
    setModalOpen(false);
    form.resetFields();
  };

  const handleFinish = (values: CreateTaskInput): void => {
    createMutation.mutate(values);
  };

  return (
    <>
      <PageHeader
        eyebrow="Task board"
        title="任务看板"
        subtitle={`每 2 秒自动刷新 · 共 ${tasks.length} 条任务`}
        extra={
          <Space size={8} wrap>
            <Button
              icon={<ReloadOutlined />}
              onClick={() => {
                void tasksQuery.refetch();
              }}
            >
              刷新
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={openModal}>
              新建任务
            </Button>
          </Space>
        }
      />

      {tasksQuery.isError ? (
        <Alert
          type="error"
          showIcon
          message="任务列表加载失败"
          description={tasksQuery.error?.message ?? "未知错误"}
          action={
            <Button
              size="small"
              onClick={() => {
                void tasksQuery.refetch();
              }}
            >
              重试
            </Button>
          }
          style={{ marginBottom: 16 }}
        />
      ) : null}

      {tasksQuery.isLoading && tasksQuery.data === undefined ? (
        <div style={{ display: "flex", justifyContent: "center", padding: "72px 0" }}>
          <Spin size="large" />
        </div>
      ) : tasks.length === 0 ? (
        <EmptyState
          icon={<AppstoreOutlined />}
          title="还没有任务"
          description="创建第一条任务，让主 AI 拆解目标并派给子智能体执行。"
          action={
            <Button type="primary" icon={<PlusOutlined />} onClick={openModal}>
              新建任务
            </Button>
          }
        />
      ) : (
        <>
          <div className="task-list">
            {pageTasks.map((task) => {
              const meta = STATUS_META[task.status];
              return (
                <article
                  key={task.id}
                  className="task-card"
                  role="button"
                  tabIndex={0}
                  aria-label={`打开任务：${task.title}`}
                  onClick={() => {
                    onOpenTask(task.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onOpenTask(task.id);
                    }
                  }}
                >
                  <span
                    aria-hidden
                    className="task-card-bar"
                    style={{ background: meta.color }}
                  />
                  <div className="task-card-main">
                    <div className="task-card-title-row">
                      <h3 className="task-card-title" title={task.title}>
                        {task.title}
                      </h3>
                    </div>
                    <p className="task-card-goal">
                      {task.goal.trim().length === 0 ? "（无目标描述）" : task.goal}
                    </p>
                    <div className="task-card-meta">
                      <span className="task-meta-item">
                        <span
                          className={
                            task.status === "running"
                              ? "task-status-dot is-running"
                              : "task-status-dot"
                          }
                          style={{ background: meta.color }}
                        />
                        {meta.label}
                      </span>
                      <span className="task-meta-item">
                        <ClockCircleOutlined />
                        创建于 {formatTime(task.createdAt)}
                      </span>
                      <span className="task-meta-item">
                        <FieldTimeOutlined />
                        耗时 {formatDuration(task)}
                      </span>
                      <span className="task-meta-item">
                        ID{" "}
                        <code className="task-id" title={task.id}>
                          {shortId(task.id)}
                        </code>
                      </span>
                    </div>
                  </div>
                  <RightOutlined aria-hidden className="task-card-chevron" />
                </article>
              );
            })}
          </div>

          {tasks.length > PAGE_SIZE ? (
            <div className="task-list-footer">
              <span>
                第 {page} / {totalPages} 页 · 共 {tasks.length} 条
              </span>
              <Pagination
                size="small"
                current={page}
                pageSize={PAGE_SIZE}
                total={tasks.length}
                showSizeChanger={false}
                onChange={setPage}
              />
            </div>
          ) : null}
        </>
      )}

      <Modal
        title="新建任务"
        open={modalOpen}
        okText="创建"
        cancelText="取消"
        confirmLoading={createMutation.isPending}
        onOk={() => {
          form.submit();
        }}
        onCancel={closeModal}
        forceRender
        width={560}
        centered
      >
        <Form<CreateTaskInput>
          form={form}
          layout="vertical"
          initialValues={{ permission: "workspace-write" }}
          onFinish={handleFinish}
          preserve={false}
        >
          <Form.Item
            name="title"
            label="标题"
            rules={[{ required: true, whitespace: true, message: "请输入任务标题" }]}
          >
            <Input placeholder="例如：整理 workspace 下的 CSV" maxLength={200} />
          </Form.Item>
          <Form.Item
            name="goal"
            label="目标"
            rules={[{ required: true, whitespace: true, message: "请输入任务目标" }]}
          >
            <Input.TextArea
              rows={5}
              placeholder="描述要达成的结果、约束与验收标准"
              maxLength={8000}
              showCount
            />
          </Form.Item>
          <Form.Item
            name="permission"
            label="权限"
            rules={[{ required: true, message: "请选择权限模式" }]}
          >
            <Select options={PERMISSION_OPTIONS} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
