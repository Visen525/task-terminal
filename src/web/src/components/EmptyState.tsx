/**
 * 统一空态（M9-01）：大图标 + 一句引导 + 可选操作。
 */
import type { ReactNode } from "react";

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  /** 嵌在卡片/面板里时用紧凑版。 */
  compact?: boolean;
}

export default function EmptyState({
  icon,
  title,
  description,
  action,
  compact = false,
}: EmptyStateProps) {
  return (
    <div className={compact ? "empty-state empty-state-compact" : "empty-state"}>
      <div className="empty-state-icon">{icon}</div>
      <p className="empty-state-title">{title}</p>
      {description === undefined ? null : (
        <p className="empty-state-description">{description}</p>
      )}
      {action === undefined ? null : <div className="empty-state-action">{action}</div>}
    </div>
  );
}
