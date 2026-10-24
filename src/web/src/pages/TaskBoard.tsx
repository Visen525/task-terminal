import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App as AntdApp,
  Button,
  Empty,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
  type TableColumnsType,
} from "antd";

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
  spinning: boolean;
}

const STATUS_META: Record<TaskStatus, StatusMeta> = {
  queued: { label: "排队中", color: "default", spinning: false },
  running: { label: "执行中", color: "processing", spinning: true },
  completed: { label: "已完成", color: "success", spinning: false },
  failed: { label: "失败", color: "error", spinning: false },
  waiting_input: { label: "等待输入", color: "warning", spinning: false },
  cancelled: { label: "已取消", color: "default", spinning: false },
};

const PERMISSION_OPTIONS: Array<{ value: PermissionMode; label: string }> = [
  { value: "workspace-write", label: "workspace-write（可写工作区）" },
  { value: "read-only", label: "read-only（只读）" },
];

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

function shortId(id: string): string {
  return id.length <= 14 ? id : `${id.slice(0, 6)}…${id.slice(-6)}`;
}

function StatusTag({ status }: { status: TaskStatus }) {
  const meta = STATUS_META[status];
  return (
    <Tag
      color={meta.color}
      icon={meta.spinning ? <Spin size="small" /> : undefined}
      style={{ marginInlineEnd: 0 }}
    >
      {meta.label}
    </Tag>
  );
}

export default function TaskBoard({ onOpenTask }: TaskBoardProps) {
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
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

  const openModal = (): void => {
    form.resetFields();
    setModalOpen(true);
  };

  const closeModal = (): void => {
    if (createMutation.isPending) return;
    setModalOpen(false);
    form.resetFields();
  };

  const columns: TableColumnsType<Task> = [
    {
      title: "任务 ID",
      dataIndex: "id",
      key: "id",
      width: 160,
      render: (_: unknown, task: Task) => (
        <Typography.Text code title={task.id}>
          {shortId(task.id)}
        </Typography.Text>
      ),
    },
    {
      title: "标题",
      dataIndex: "title",
      key: "title",
      ellipsis: true,
      render: (_: unknown, task: Task) => <Typography.Text strong>{task.title}</Typography.Text>,
    },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 130,
      render: (_: unknown, task: Task) => <StatusTag status={task.status} />,
    },
    {
      title: "创建时间",
      dataIndex: "createdAt",
      key: "createdAt",
      width: 190,
      render: (_: unknown, task: Task) => formatTime(task.createdAt),
    },
    {
      title: "结束时间",
      dataIndex: "endedAt",
      key: "endedAt",
      width: 190,
      render: (_: unknown, task: Task) => formatTime(task.endedAt),
    },
  ];

  const handleFinish = (values: CreateTaskInput): void => {
    createMutation.mutate(values);
  };

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <div>
          <Typography.Title level={3} style={{ margin: 0 }}>
            任务看板
          </Typography.Title>
          <Typography.Text type="secondary">
            每 2 秒自动刷新，共 {tasksQuery.data?.length ?? 0} 条任务
          </Typography.Text>
        </div>
        <Space>
          <Button
            onClick={() => {
              void tasksQuery.refetch();
            }}
          >
            刷新
          </Button>
          <Button type="primary" onClick={openModal}>
            新建任务
          </Button>
        </Space>
      </div>

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
        />
      ) : null}

      <Table<Task>
        rowKey="id"
        columns={columns}
        dataSource={tasksQuery.data ?? []}
        loading={tasksQuery.isLoading}
        pagination={{ pageSize: 12, showSizeChanger: false, hideOnSinglePage: true }}
        scroll={{ x: 900 }}
        onRow={(task) => ({
          onClick: () => {
            onOpenTask(task.id);
          },
          style: { cursor: "pointer" },
        })}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="还没有任务。点击右上角「新建任务」，开始第一条任务吧。"
            />
          ),
        }}
      />

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
    </Space>
  );
}
