/**
 * 首次运行初始化向导（M10-02）。
 *
 * 触发条件由 App 判定：GET /settings 成功且 workspaceDir === null。
 * 三步：欢迎 → 选择工作空间（内嵌目录浏览器）→ 确认并 PUT 保存。
 * 「稍后再说」只跳过本次浏览器会话，下次启动仍会提示。
 */
import { useEffect, useState } from "react";
import { Alert, App as AntdApp, Button, Modal, Steps, Typography } from "antd";
import {
  FolderOpenOutlined,
  RocketOutlined,
  SafetyCertificateOutlined,
  ThunderboltFilled,
} from "@ant-design/icons";

import { DirectoryBrowserPanel } from "./DirectoryBrowser";
import { parseSettingsFieldErrors, putSettings, type AppSettings } from "../settingsApi";

interface SetupWizardProps {
  open: boolean;
  /** 「稍后再说」：由 App 写入本次会话标记并关闭。 */
  onSkip: () => void;
  onSaved: (settings: AppSettings) => void;
}

const STEP_ITEMS = [{ title: "欢迎" }, { title: "选择工作空间" }, { title: "开始使用" }];

export default function SetupWizard({ open, onSkip, onSaved }: SetupWizardProps) {
  const { message } = AntdApp.useApp();
  const [step, setStep] = useState(0);
  const [workspaceDir, setWorkspaceDir] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setStep(0);
    setWorkspaceDir(null);
    setSaving(false);
    setSaveError(null);
  }, [open]);

  const saveWorkspace = async (): Promise<void> => {
    if (workspaceDir === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await putSettings({ workspaceDir });
      message.success("工作空间已保存，开始使用任务终端");
      onSaved(saved);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : "保存失败，请重试";
      const parsed = parseSettingsFieldErrors(reason);
      if (parsed.fieldErrors.workspaceDir !== undefined) {
        setSaveError(parsed.fieldErrors.workspaceDir);
        setStep(1);
      } else if (parsed.general.length > 0) {
        setSaveError(parsed.general.join("；"));
      } else {
        setSaveError(reason);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      className="setup-wizard"
      open={open}
      footer={null}
      closable={false}
      maskClosable={false}
      keyboard={false}
      centered
      width={880}
    >
      <div className="wizard-shell">
        <div className="wizard-brand">
          <div className="wizard-brand-mark">
            <ThunderboltFilled />
          </div>
          <div>
            <div className="wizard-brand-title">任务终端</div>
            <div className="wizard-brand-sub">本地 AI 任务台 · 首次设置</div>
          </div>
        </div>

        <div className="wizard-steps">
          <Steps current={step} items={STEP_ITEMS} size="small" />
        </div>

        <div className="wizard-body">
          {step === 0 ? (
            <div className="wizard-welcome">
              <div className="wizard-welcome-icon">
                <RocketOutlined />
              </div>
              <h2 className="wizard-welcome-title">欢迎使用任务终端</h2>
              <p className="wizard-welcome-text">
                把目标交给主 AI，它负责拆解、派活、留痕，所有文件与记忆都留在本地。
              </p>
              <div className="wizard-feature-grid">
                <div className="wizard-feature">
                  <SafetyCertificateOutlined />
                  <span>本地优先，数据不出机器</span>
                </div>
                <div className="wizard-feature">
                  <FolderOpenOutlined />
                  <span>指定一个工作空间开始干活</span>
                </div>
              </div>
              <p className="wizard-hint">
                下一步选择一个目录作为默认工作空间。之后创建的每个任务都会在它的子目录里执行。
              </p>
            </div>
          ) : null}

          {step === 1 ? (
            <div className="wizard-workspace">
              {saveError === null ? null : (
                <Alert
                  type="error"
                  showIcon
                  message="目录校验未通过"
                  description={saveError}
                  className="wizard-error"
                />
              )}
              <DirectoryBrowserPanel
                initialPath={workspaceDir}
                confirmLabel="使用此目录"
                onConfirm={(path) => {
                  setWorkspaceDir(path);
                  setSaveError(null);
                  setStep(2);
                }}
              />
              <p className="wizard-hint">
                单击目录进入，或用「前往」手输路径；确认的是当前所在目录。
              </p>
            </div>
          ) : null}

          {step === 2 ? (
            <div className="wizard-finish">
              <div className="wizard-welcome-icon">
                <FolderOpenOutlined />
              </div>
              <h2 className="wizard-welcome-title">工作空间已就绪</h2>
              <p className="wizard-welcome-text">
                任务会在这个目录里执行，产物与长期记忆都保存在本地。之后可在设置页随时更改。
              </p>
              <div className="wizard-summary">
                <span className="info-label">默认工作空间</span>
                <Typography.Text code className="wizard-summary-path">
                  {workspaceDir ?? "—"}
                </Typography.Text>
              </div>
              {saveError === null ? null : (
                <Alert
                  type="error"
                  showIcon
                  message="保存失败"
                  description={saveError}
                  className="wizard-error"
                />
              )}
            </div>
          ) : null}
        </div>

        <div className="wizard-actions">
          <Button type="text" onClick={onSkip} disabled={saving}>
            稍后再说
          </Button>
          <div className="wizard-actions-right">
            {step > 0 ? (
              <Button
                onClick={() => {
                  setSaveError(null);
                  setStep(step - 1);
                }}
                disabled={saving}
              >
                上一步
              </Button>
            ) : null}
            {step === 0 ? (
              <Button type="primary" onClick={() => setStep(1)}>
                开始设置
              </Button>
            ) : null}
            {step === 2 ? (
              <Button
                type="primary"
                loading={saving}
                onClick={() => {
                  void saveWorkspace();
                }}
              >
                开始使用
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </Modal>
  );
}
