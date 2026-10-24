/**
 * M9-01 视觉主题：单一靛蓝主色、10px 圆角、冷灰中性色与系统字体栈。
 *
 * 只影响视觉 token，不改变任何组件行为；页面级细节在 styles.css 中收敛。
 */
import type { ThemeConfig } from "antd";

export const PRIMARY_COLOR = "#4F46E5";

export const themeConfig: ThemeConfig = {
  token: {
    colorPrimary: PRIMARY_COLOR,
    colorInfo: PRIMARY_COLOR,
    colorLink: PRIMARY_COLOR,
    colorLinkHover: "#6366F1",

    borderRadius: 10,
    borderRadiusLG: 12,
    borderRadiusSM: 6,
    fontSize: 14,

    fontFamily:
      '-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',

    colorText: "#1F2937",
    colorTextSecondary: "#6B7280",
    colorTextTertiary: "#9CA3AF",
    colorTextQuaternary: "#D1D5DB",
    colorTextHeading: "#111827",

    colorBorder: "#E5E7EB",
    colorBorderSecondary: "#EEF0F3",
    colorSplit: "#F1F5F9",
    colorBgLayout: "#F8FAFC",
    colorBgContainer: "#FFFFFF",
    colorBgElevated: "#FFFFFF",
    colorFillAlter: "#F8FAFC",
    colorFillSecondary: "#F3F4F6",
    colorFillTertiary: "#F9FAFB",

    boxShadow: "0 1px 2px rgba(17, 24, 39, 0.04)",
    boxShadowSecondary: "0 8px 24px rgba(17, 24, 39, 0.06)",
    boxShadowTertiary: "0 2px 8px rgba(17, 24, 39, 0.05)",

    controlOutline: "rgba(79, 70, 229, 0.14)",
    controlOutlineWidth: 3,
    wireframe: false,
  },
  components: {
    Layout: {
      bodyBg: "#F8FAFC",
      headerBg: "#FFFFFF",
      siderBg: "#FFFFFF",
      lightSiderBg: "#FFFFFF",
    },
    Menu: {
      itemBg: "transparent",
      itemColor: "#4B5563",
      itemHoverColor: "#111827",
      itemHoverBg: "#F8FAFC",
      itemSelectedColor: PRIMARY_COLOR,
      itemSelectedBg: "#EEF2FF",
      itemActiveBg: "#EEF2FF",
      itemBorderRadius: 8,
      itemHeight: 42,
      itemMarginBlock: 4,
      itemMarginInline: 12,
      itemPaddingInline: 12,
      iconMarginInlineEnd: 10,
      iconSize: 16,
    },
    Card: {
      headerHeight: 48,
      bodyPadding: 18,
      headerPadding: 16,
    },
    Button: {
      controlHeight: 36,
      primaryShadow: "none",
      defaultShadow: "none",
      dangerShadow: "none",
      fontWeight: 500,
    },
    Input: {
      controlHeight: 38,
      activeShadow: "0 0 0 3px rgba(79, 70, 229, 0.12)",
    },
    Select: {
      controlHeight: 38,
      optionSelectedBg: "#EEF2FF",
      optionSelectedFontWeight: 500,
    },
    Tag: {
      defaultBg: "#F3F4F6",
      defaultColor: "#4B5563",
      borderRadiusSM: 6,
    },
    Progress: {
      defaultColor: PRIMARY_COLOR,
      remainingColor: "#EEF0F3",
    },
    Modal: {
      borderRadiusLG: 16,
      contentBg: "#FFFFFF",
      headerBg: "#FFFFFF",
    },
  },
};
