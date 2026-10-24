/**
 * 目录浏览器（M10-02）。
 *
 * 数据只来自 GET /fs/browse：每个条目只有 name / enterable，前端不猜测、不读取
 * 工作区外的任何内容。设置页以 Modal 使用；初始化向导内嵌同一个 Panel，避免
 * 弹窗里再套弹窗。
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, App as AntdApp, Button, Empty, Input, Modal, Spin, Tooltip } from "antd";
import {
  ArrowUpOutlined,
  CheckOutlined,
  CopyOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  ReloadOutlined,
  RightOutlined,
} from "@ant-design/icons";

import { browseDirectory, type BrowseResult } from "../settingsApi";

interface BreadcrumbItem {
  label: string;
  path: string;
}

function pathSeparator(path: string): string {
  return path.includes("\\") ? "\\" : "/";
}

/** 把后端返回的绝对路径拆成可点击面包屑；不写死盘符或根路径。 */
export function buildBreadcrumbs(path: string): BreadcrumbItem[] {
  const normalized = path.replace(/\\/gu, "/");
  if (normalized.length === 0) return [];

  if (normalized.startsWith("//")) {
    const parts = normalized.slice(2).split("/").filter(Boolean);
    const server = parts[0];
    if (server === undefined) return [{ label: "//", path: "//" }];
    const root = `//${server}`;
    const items: BreadcrumbItem[] = [{ label: root, path: root }];
    let current = root;
    for (const part of parts.slice(1)) {
      current = `${current}/${part}`;
      items.push({ label: part, path: current });
    }
    return items;
  }

  const drive = /^([A-Za-z]:)(?:\/|$)/u.exec(normalized);
  if (drive !== null) {
    const driveName = drive[1] ?? "";
    const root = `${driveName}/`;
    const items: BreadcrumbItem[] = [{ label: driveName, path: root }];
    let current = root;
    for (const part of normalized.slice(driveName.length).split("/")) {
      if (part.length === 0) continue;
      current = `${current}${part}`;
      items.push({ label: part, path: current });
    }
    return items;
  }

  const root = normalized.startsWith("/") ? "/" : "";
  const items: BreadcrumbItem[] = root === "" ? [] : [{ label: "/", path: "/" }];
  let current = root;
  for (const part of normalized.slice(root.length).split("/")) {
    if (part.length === 0) continue;
    current = current.endsWith("/") ? `${current}${part}` : `${current}/${part}`;
    items.push({ label: part, path: current });
  }
  if (items.length === 0) return [{ label: path, path }];
  return items;
}

function joinDirectory(parent: string, name: string): string {
  const trimmed = parent.replace(/[\\/]+$/u, "");
  const separator = pathSeparator(parent);
  if (trimmed.length === 0) return `${separator}${name}`;
  return `${trimmed}${separator}${name}`;
}

function parentDirectory(path: string): string {
  const trimmed = path.replace(/[\\/]+$/u, "");
  if (trimmed.length === 0) return path;
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (index < 0) return path;
  const parent = trimmed.slice(0, index);
  if (/^[A-Za-z]:$/u.test(parent)) return `${parent}${pathSeparator(path)}`;
  if (parent.length === 0) return pathSeparator(path);
  return parent;
}

interface DirectoryBrowserPanelProps {
  /** 打开时定位到的目录；null 表示让后端从当前盘根开始。 */
  initialPath?: string | null;
  confirmLabel?: string;
  onConfirm: (path: string) => void;
}

export function DirectoryBrowserPanel({
  initialPath = null,
  confirmLabel = "使用此目录",
  onConfirm,
}: DirectoryBrowserPanelProps) {
  const { message } = AntdApp.useApp();
  const initial = initialPath?.trim() ?? "";
  const [targetPath, setTargetPath] = useState<string | null>(
    initial.length === 0 ? null : initial,
  );
  const [pathInput, setPathInput] = useState(initial);

  const browseQuery = useQuery<BrowseResult>({
    queryKey: ["fs", "browse", targetPath ?? "__default__"],
    queryFn: () => browseDirectory(targetPath ?? undefined),
    retry: false,
    staleTime: 0,
  });

  const data = browseQuery.data;
  const currentPath = data?.path ?? targetPath ?? "";

  useEffect(() => {
    if (data !== undefined) setPathInput(data.path);
  }, [data?.path]);

  const breadcrumbs = useMemo(() => buildBreadcrumbs(currentPath), [currentPath]);

  const go = (path: string): void => {
    const trimmed = path.trim();
    if (trimmed.length === 0) return;
    if (trimmed === targetPath) {
      void browseQuery.refetch();
      return;
    }
    setTargetPath(trimmed);
  };

  const copyCurrentPath = async (): Promise<void> => {
    if (currentPath.length === 0) return;
    try {
      await navigator.clipboard.writeText(currentPath);
      message.success("路径已复制");
    } catch {
      message.error("复制失败，请手动选中路径复制");
    }
  };

  return (
    <div className="dir-browser">
      <div className="dir-toolbar">
        <div className="dir-toolbar-actions">
          <Tooltip title="返回上一级">
            <Button
              icon={<ArrowUpOutlined />}
              disabled={currentPath.length === 0}
              onClick={() => {
                go(parentDirectory(currentPath));
              }}
            >
              上级
            </Button>
          </Tooltip>
          <Tooltip title="重新读取当前目录">
            <Button
              icon={<ReloadOutlined />}
              loading={browseQuery.isFetching}
              onClick={() => {
                void browseQuery.refetch();
              }}
            />
          </Tooltip>
        </div>

        <div className="dir-breadcrumb" aria-label="当前路径面包屑">
          {breadcrumbs.map((crumb, index) => (
            <span className="dir-crumb-item" key={`${crumb.path}-${String(index)}`}>
              {index > 0 ? <span className="dir-crumb-sep">/</span> : null}
              <button
                type="button"
                className="dir-crumb"
                onClick={() => {
                  go(crumb.path);
                }}
              >
                {crumb.label}
              </button>
            </span>
          ))}
        </div>

        <Tooltip title="复制当前路径">
          <Button
            icon={<CopyOutlined />}
            aria-label="复制当前路径"
            disabled={currentPath.length === 0}
            onClick={() => {
              void copyCurrentPath();
            }}
          />
        </Tooltip>
      </div>

      <div className="dir-path-row">
        <Input
          value={pathInput}
          prefix={<FolderOpenOutlined />}
          placeholder="手输目录路径后点「前往」"
          aria-label="目录路径"
          onChange={(event) => {
            setPathInput(event.target.value);
          }}
          onPressEnter={() => {
            go(pathInput);
          }}
        />
        <Button
          type="primary"
          ghost
          onClick={() => {
            go(pathInput);
          }}
        >
          前往
        </Button>
      </div>

      {browseQuery.error === null ? null : (
        <Alert
          className="dir-error"
          type="error"
          showIcon
          message="目录读取失败"
          description={browseQuery.error.message}
        />
      )}

      {data !== undefined && data.truncated ? (
        <Alert
          className="dir-truncated"
          type="warning"
          showIcon
          message={`目录过多，仅显示前 ${String(data.limit)} 个（共 ${String(data.total)} 个）。可手输更具体的路径。`}
        />
      ) : null}

      <div className="dir-list" aria-label="目录列表">
        {browseQuery.isLoading ? (
          <div className="dir-loading">
            <Spin />
            <span>读取目录…</span>
          </div>
        ) : data === undefined || data.entries.length === 0 ? (
          <Empty
            className="dir-empty"
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="这个目录下没有子目录"
          />
        ) : (
          data.entries.map((entry) => (
            <button
              key={entry.name}
              type="button"
              className="dir-entry"
              disabled={!entry.enterable}
              title={entry.enterable ? entry.name : `${entry.name}（无权限进入）`}
              onClick={() => {
                go(joinDirectory(data.path, entry.name));
              }}
            >
              <FolderOutlined className="dir-entry-icon" />
              <span className="dir-entry-name">{entry.name}</span>
              {entry.enterable ? (
                <RightOutlined className="dir-entry-chevron" />
              ) : (
                <span className="dir-entry-note">无权限</span>
              )}
            </button>
          ))
        )}
      </div>

      <div className="dir-footer">
        <div className="dir-current">
          <span className="dir-current-label">当前目录</span>
          <code className="dir-current-path" title={currentPath}>
            {currentPath.length === 0 ? "—" : currentPath}
          </code>
        </div>
        <Button
          type="primary"
          icon={<CheckOutlined />}
          disabled={data === undefined}
          onClick={() => {
            if (data !== undefined) onConfirm(data.path);
          }}
        >
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}

interface DirectoryBrowserModalProps {
  open: boolean;
  initialPath?: string | null;
  onClose: () => void;
  onConfirm: (path: string) => void;
}

export default function DirectoryBrowserModal({
  open,
  initialPath = null,
  onClose,
  onConfirm,
}: DirectoryBrowserModalProps) {
  return (
    <Modal
      title="选择工作空间目录"
      open={open}
      footer={null}
      centered
      width={760}
      destroyOnHidden
      onCancel={onClose}
    >
      {open ? <DirectoryBrowserPanel initialPath={initialPath} onConfirm={onConfirm} /> : null}
    </Modal>
  );
}
