import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * 开发期由 Vite 代理到本机后端，前端代码只使用相对路径。
 * 生产构建输出仓库根目录的 dist/（已在 .gitignore 中）。
 */
const webRoot = fileURLToPath(new URL(".", import.meta.url));
const backendTarget = "http://127.0.0.1:4310";

export default defineConfig({
  root: webRoot,
  plugins: [react()],
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
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
