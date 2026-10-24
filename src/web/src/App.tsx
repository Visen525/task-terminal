import { useState, type ReactNode } from "react";
import { Button, Layout, Menu, Tooltip } from "antd";
import {
  AppstoreOutlined,
  FolderOpenOutlined,
  MessageOutlined,
  ProfileOutlined,
  SettingOutlined,
  ThunderboltFilled,
} from "@ant-design/icons";

import EmptyState from "./components/EmptyState";
import PageHeader from "./components/PageHeader";
import Artifacts from "./pages/Artifacts";
import Chat from "./pages/Chat";
import TaskBoard from "./pages/TaskBoard";
import TaskDetail from "./pages/TaskDetail";

const { Content, Sider } = Layout;

type ViewKey = "board" | "detail" | "artifacts" | "chat";

const MENU_ITEMS = [
  { key: "board", icon: <AppstoreOutlined />, label: "任务看板" },
  { key: "detail", icon: <ProfileOutlined />, label: "任务详情" },
  { key: "artifacts", icon: <FolderOpenOutlined />, label: "产物库" },
  { key: "chat", icon: <MessageOutlined />, label: "对话" },
];

function DetailPlaceholder() {
  return (
    <>
      <PageHeader
        eyebrow="Task detail"
        title="任务详情"
        subtitle="从看板或产物库选择一条任务，查看目标、预算与执行时间线。"
      />
      <EmptyState
        icon={<ProfileOutlined />}
        title="还没有选择任务"
        description="请先在「任务看板」点击一条任务。"
      />
    </>
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
        <DetailPlaceholder />
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
    <Layout className="app-shell">
      <Sider theme="light" width={208} className="app-sider">
        <div className="app-brand">
          <div className="app-brand-mark">
            <ThunderboltFilled />
          </div>
          <div>
            <div className="app-brand-title">任务终端</div>
            <div className="app-brand-sub">本地 AI 任务台</div>
          </div>
        </div>
        <Menu
          mode="inline"
          selectedKeys={[activeKey]}
          items={MENU_ITEMS}
          onClick={({ key }) => {
            setActiveKey(key as ViewKey);
          }}
          className="app-nav"
        />
        <div className="app-sider-footer">
          <span>v1.1.0</span>
          <Tooltip title="设置（M9-02 开放）" placement="top">
            <Button type="text" size="small" icon={<SettingOutlined />} aria-label="设置" />
          </Tooltip>
        </div>
      </Sider>
      <Layout className="app-main">
        <Content className="app-content">
          <div
            className="app-page"
            style={{ maxWidth: activeKey === "chat" ? 860 : 1080 }}
          >
            {content}
          </div>
        </Content>
      </Layout>
    </Layout>
  );
}
