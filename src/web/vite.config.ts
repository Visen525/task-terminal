import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * 开发期由 Vite 代理到本机后端，前端代码只使用相对路径。
 * 生产构建输出仓库根目录的 dist/（已在 .gitignore 中）。
 */
const webRoot = fileURLToPath(new URL(".", import.meta.url));
const backendTarget = "http://127.0.0.1:4310";

/** antd 组件按职责拆成三组，避免 antd 整包落进一个 >500kB 的 chunk。 */
const ANTD_FORM_COMPONENTS = new Set([
  "alert",
  "drawer",
  "dropdown",
  "form",
  "input",
  "menu",
  "modal",
  "pagination",
  "popconfirm",
  "popover",
  "progress",
  "select",
  "switch",
  "tooltip",
]);
const ANTD_DISPLAY_COMPONENTS = new Set([
  "app",
  "avatar",
  "badge",
  "button",
  "card",
  "descriptions",
  "divider",
  "empty",
  "flex",
  "grid",
  "icon",
  "layout",
  "list",
  "message",
  "notification",
  "result",
  "skeleton",
  "space",
  "spin",
  "statistic",
  "tag",
  "typography",
]);

export default defineConfig({
  root: webRoot,
  plugins: [react()],
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // M9-01：把 antd 按职责拆成多个 vendor chunk；React 作为公共依赖由 Rolldown
        // 合并进 antd-core（最终 433kB，仍低于 500kB 告警线）。
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (
            id.includes("node_modules/react/") ||
            id.includes("node_modules/react-dom/") ||
            id.includes("node_modules/scheduler/")
          ) {
            return "react";
          }
          if (id.includes("node_modules/@ant-design/icons")) return "icons";
          if (id.includes("node_modules/@rc-component/") || /node_modules\/rc-[^/]+\//u.test(id)) {
            return "antd-rc";
          }
          if (id.includes("node_modules/antd/")) {
            const component = /node_modules\/antd\/es\/([^/]+)/u.exec(id)?.[1];
            if (component !== undefined) {
              if (ANTD_FORM_COMPONENTS.has(component)) return "antd-form";
              if (ANTD_DISPLAY_COMPONENTS.has(component)) return "antd-display";
            }
            return "antd-core";
          }
          if (id.includes("node_modules/@tanstack/")) return "tanstack";
          if (
            id.includes("node_modules/react-markdown/") ||
            id.includes("node_modules/remark-") ||
            id.includes("node_modules/rehype-") ||
            id.includes("node_modules/micromark") ||
            id.includes("node_modules/mdast-") ||
            id.includes("node_modules/hast-") ||
            id.includes("node_modules/unified") ||
            id.includes("node_modules/vfile") ||
            id.includes("node_modules/unist-")
          ) {
            return "markdown";
          }
          return "vendor";
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/tasks": { target: backendTarget, changeOrigin: true },
      "/events": { target: backendTarget, changeOrigin: true },
      "/artifacts": { target: backendTarget, changeOrigin: true },
      "/messages": { target: backendTarget, changeOrigin: true },
      "/chat": { target: backendTarget, changeOrigin: true },
    },
  },
});
