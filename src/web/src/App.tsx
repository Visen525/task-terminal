import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import SetupWizard from "./components/SetupWizard";
import Artifacts from "./pages/Artifacts";
import Chat from "./pages/Chat";
import Settings from "./pages/Settings";
import TaskBoard from "./pages/TaskBoard";
import TaskDetail from "./pages/TaskDetail";
import { getSettings, type AppSettings } from "./settingsApi";

const { Content, Sider } = Layout;

/**
 * 向导跳过标记存 localStorage，但绑定一个只存在于当前浏览器会话的 sessionStorage
 * id：同一会话刷新不再弹，关掉标签页/下次启动会生成新 id、旧标记不匹配，重新提示。
 */
const WIZARD_SKIP_KEY = "tt.setup-wizard.skipped";
const WIZARD_SESSION_KEY = "tt.setup-wizard.session";

function readSessionId(): string | null {
  try {
    const existing = window.sessionStorage.getItem(WIZARD_SESSION_KEY);
    if (existing !== null && existing.length > 0) return existing;
    const generated =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    window.sessionStorage.setItem(WIZARD_SESSION_KEY, generated);
    return generated;
  } catch {
    return null;
  }
}

function readWizardSkipped(): boolean {
  try {
    const sessionId = readSessionId();
    return sessionId !== null && window.localStorage.getItem(WIZARD_SKIP_KEY) === sessionId;
  } catch {
    return false;
  }
}

function writeWizardSkipped(): void {
  try {
    const sessionId = readSessionId();
    if (sessionId !== null) window.localStorage.setItem(WIZARD_SKIP_KEY, sessionId);
  } catch {
    // 存储不可用时至少让本次挂载不再重复弹；下次启动仍会提示。
  }
}

type ViewKey = "board" | "detail" | "artifacts" | "chat" | "settings";

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
  const [wizardSkipped, setWizardSkipped] = useState(readWizardSkipped);
  const queryClient = useQueryClient();

  const settingsQuery = useQuery({
    queryKey: ["settings", "current"],
    queryFn: getSettings,
  });

  const openTask = (taskId: string): void => {
    setSelectedTaskId(taskId);
    setActiveKey("detail");
  };

  const dismissWizard = (): void => {
    writeWizardSkipped();
    setWizardSkipped(true);
  };

  const finishWizard = (settings: AppSettings): void => {
    queryClient.setQueryData(["settings", "current"], settings);
    setWizardSkipped(true);
    void queryClient.invalidateQueries({ queryKey: ["settings", "overview"] });
  };

  // 只有读取成功、workspaceDir 明确为 null，且本次会话没点过「稍后再说」才弹。
  const showWizard =
    !wizardSkipped && settingsQuery.data !== undefined && settingsQuery.data.workspaceDir === null;

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
  } else if (activeKey === "settings") {
    content = <Settings onOpenTask={openTask} />;
  } else {
    content = <Chat />;
  }

  return (
    <>
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
            selectedKeys={activeKey === "settings" ? [] : [activeKey]}
            items={MENU_ITEMS}
            onClick={({ key }) => {
              setActiveKey(key as ViewKey);
            }}
            className="app-nav"
          />
          <div className="app-sider-footer">
            <span>v1.1.0</span>
            <Tooltip title="设置" placement="top">
              <Button
                type={activeKey === "settings" ? "primary" : "text"}
                size="small"
                icon={<SettingOutlined />}
                aria-label="设置"
                aria-pressed={activeKey === "settings"}
                onClick={() => {
                  setActiveKey("settings");
                }}
              />
            </Tooltip>
          </div>
        </Sider>
        <Layout className="app-main">
          <Content className="app-content">
            <div className="app-page" style={{ maxWidth: activeKey === "chat" ? 860 : 1080 }}>
              {content}
            </div>
          </Content>
        </Layout>
      </Layout>

      <SetupWizard open={showWizard} onSkip={dismissWizard} onSaved={finishWizard} />
    </>
  );
}
