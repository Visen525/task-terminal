import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntdApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";

import "antd/dist/reset.css";

import App from "./App";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const container = document.getElementById("root");
if (container === null) {
  throw new Error("找不到 #root 挂载点，index.html 可能被破坏");
}

createRoot(container).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN}>
      <AntdApp>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </AntdApp>
    </ConfigProvider>
  </React.StrictMode>,
);
