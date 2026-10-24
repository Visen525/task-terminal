/**
 * 开发期双进程启动器（M6-01）。
 *
 * 后端：node src/index.ts（Node 24 原生跑 TS）
 * 前端：pnpm dev:web（Vite dev server，代理 /tasks 等到 127.0.0.1:4310）
 *
 * Ctrl-C（SIGINT）或任一子进程退出时，停止全部子进程并退出。
 * Windows 下必须用 taskkill /T 树杀，否则 pnpm/cmd/vite 会留下孤儿进程。
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import process from "node:process";

interface ChildEntry {
  label: string;
  child: ChildProcess;
}

const children: ChildEntry[] = [];
let shuttingDown = false;
let exitCode = 0;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function treeKill(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;

  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (result.error !== undefined) {
      console.error(`[dev] taskkill 失败: ${result.error.message}`);
    }
    return;
  }

  try {
    child.kill("SIGTERM");
  } catch (error) {
    console.error(`[dev] 结束进程失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  exitCode = code;

  if (children.length > 0) {
    console.error(`[dev] 正在停止 ${children.length} 个子进程…`);
  }
  for (const { child } of children) treeKill(child);

  // Windows 的 taskkill /F 是同步的；POSIX 先给 2 秒优雅退出，再强制结束。
  if (process.platform !== "win32") {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && children.some(({ child }) => child.exitCode === null)) {
      await delay(50);
    }
    for (const { child } of children) {
      if (child.exitCode !== null) continue;
      try {
        child.kill("SIGKILL");
      } catch (error) {
        console.error(
          `[dev] 强制结束进程失败: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  process.exit(exitCode);
}

function start(label: string, command: string, args: string[]): void {
  console.log(`[dev] 启动 ${label}: ${command} ${args.join(" ")}`);
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  children.push({ label, child });

  child.once("error", (error) => {
    if (shuttingDown) return;
    console.error(`[dev] ${label} 启动失败: ${error.message}`);
    void shutdown(1);
  });

  child.once("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(
      `[dev] ${label} 已退出（code=${code === null ? "null" : String(code)}, signal=${signal ?? "null"}），停止其余进程`,
    );
    void shutdown(code === null || code === 0 ? 1 : code);
  });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.error(`\n[dev] 收到 ${signal}，停止全部进程`);
    void shutdown(0);
  });
}

// 后端：直接跑当前 Node，不经过 pnpm，Ctrl-C 时 taskkill 仍能按 PID 树杀。
start("backend", process.execPath, ["src/index.ts"]);

// 前端：任务卡要求走 pnpm dev:web；Windows 下经 cmd.exe 执行 pnpm.cmd，
// 避免 shell:true + args 的 DEP0190 警告。
if (process.platform === "win32") {
  start("web", process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "pnpm dev:web"]);
} else {
  start("web", "pnpm", ["dev:web"]);
}
