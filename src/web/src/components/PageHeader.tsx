/**
 * 页面标题（M9-01）：内容区自带标题，不再依赖全局顶栏。
 *
 * 纯展示组件，title / subtitle / extra 由各页面传入。
 */
import type { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  subtitle?: ReactNode;
  /** 小号眉标，可省略。 */
  eyebrow?: string;
  extra?: ReactNode;
}

export default function PageHeader({ title, subtitle, eyebrow, extra }: PageHeaderProps) {
  return (
    <div className="page-header">
      <div className="page-header-main">
        {eyebrow === undefined ? null : <span className="page-eyebrow">{eyebrow}</span>}
        <h1 className="page-title">{title}</h1>
        {subtitle === undefined ? null : <p className="page-subtitle">{subtitle}</p>}
      </div>
      {extra === undefined ? null : <div className="page-header-extra">{extra}</div>}
    </div>
  );
}
