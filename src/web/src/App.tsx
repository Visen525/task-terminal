import { useState, type ReactNode } from "react";
import { Empty, Layout, Menu, Space, Typography } from "antd";

import Artifacts from "./pages/Artifacts";
import Chat from "./pages/Chat";
import TaskBoard from "./pages/TaskBoard";
import TaskDetail from "./pages/TaskDetail";

const { Content, Header, Sider } = Layout;

type ViewKey = "board" | "detail" | "artifacts" | "chat";

const MENU_ITEMS = [
  { key: "board", label: "任务看板" },
  { key: "detail", label: "任务详情" },
  { key: "artifacts", label: "产物库" },
  { key: "chat", label: "对话" },
];

function Placeholder({ title, description }: { title: string; description: string }) {
  return (
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      style={{ marginTop: 120 }}
      description={
        <Space direction="vertical" size={4}>
          <Typography.Text strong>{title}</Typography.Text>
          <Typography.Text type="secondary">{description}</Typography.Text>
        </Space>
      }
    />
  );
}

export default function App() {
  // M6-01 用极简 state 路由；不引入 react-router。
  const [activeKey, setActiveKey] = useState<ViewKey>("board");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const openTask = (taskId: string): void => {
    setSelectedTaskId(taskId);
    setActiveKey("detail");
  };

  let content: ReactNode;
  if (activeKey === "board") {
    content = <TaskBoard onOpenTask={openTask} />;
  } else if (activeKey === "detail") {
    content =
      selectedTaskId === null ? (
        <Placeholder title="任务详情" description="请先在「任务看板」点击一条任务。" />
      ) : (
        <TaskDetail
          taskId={selectedTaskId}
          onBack={() => {
            setActiveKey("board");
          }}
        />
      );
  } else if (activeKey === "artifacts") {
    content = <Artifacts onOpenTask={openTask} />;
  } else {
    content = <Chat />;
  }

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Sider theme="light" width={210} style={{ borderRight: "1px solid #f0f0f0" }}>
        <div style={{ padding: "20px 24px", fontSize: 18, fontWeight: 600 }}>任务终端</div>
        <Menu
          mode="inline"
          selectedKeys={[activeKey]}
          items={MENU_ITEMS}
          onClick={({ key }) => {
            setActiveKey(key as ViewKey);
          }}
          style={{ borderInlineEnd: "none" }}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: "#fff",
            padding: "0 24px",
            borderBottom: "1px solid #f0f0f0",
            display: "flex",
            alignItems: "center",
          }}
        >
          <Typography.Text type="secondary">本地优先的个人 AI 任务台</Typography.Text>
        </Header>
        <Content style={{ padding: 24, background: "#f5f5f5" }}>
          <div
            style={{
              background: "#fff",
              borderRadius: 8,
              padding: 24,
              minHeight: "calc(100vh - 112px)",
            }}
          >
            {content}
          </div>
        </Content>
      </Layout>
    </Layout>
  );
}
