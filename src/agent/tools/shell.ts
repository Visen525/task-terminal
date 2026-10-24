/**
 * 子智能体 · 命令工具（SPEC §4.6 / §7 M3-02）
 *
 * `run_command` 的实现保留在 executeTool.ts：命令执行原语（输出落盘、
 * 超时杀树、硬拒绝、shell 串检查）已在 M3-01 验收，不在本卡搬动。
 * 本模块只提供白名单常量与注册入口；argv[0] 经 commandStem 归一化后
 * 必须命中 DEFAULT_ALLOWED_COMMANDS（或注入的白名单）。
 */
import { RUN_COMMAND_SPEC, registerTool, runCommandTool } from "../executeTool.ts";

// 实现保留在 executeTool；按 M3-02 约定由本模块 re-export。
export { RUN_COMMAND_SPEC, runCommandTool };

/**
 * run_command 的默认白名单（stem 形式，大小写不敏感）。
 *
 * cmd / powershell / pwsh 在清单里并不放宽安全边界：argv 级硬拒绝清单、
 * shell 串分词检查、工作区内删除目标校验仍然全部生效，白名单只是第一道闸。
 */
export const DEFAULT_ALLOWED_COMMANDS: readonly string[] = [
  "node",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "git",
  "python",
  "python3",
  "py",
  "pip",
  "cmd",
  "powershell",
  "pwsh",
  "where",
  "tar",
  "robocopy",
];

/** 由 executeTool 在首次调用时执行，确保模块常量已全部初始化。 */
export function registerShellTools(): void {
  registerTool({ spec: RUN_COMMAND_SPEC, handler: runCommandTool });
}
