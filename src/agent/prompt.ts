/**
 * 执行内核 · 子智能体系统提示（SPEC 附录 B 骨架 / §7 M3-03）
 *
 * 提示词只描述目标、工作区与权限，不携带主线上文：
 * 子智能体只看自己这一摊事（SPEC §4.7 第 3 条）。
 */
import type { PermissionMode } from '../core/types.ts';

export interface AgentPromptTask {
  id?: string;
  title?: string;
  goal: string;
  permission?: PermissionMode;
  workspace?: string;
}

const PERMISSION_TEXT: Record<PermissionMode, string> = {
  'read-only': 'read-only（只读）：可以读取工作区内文件；write_file 与 run_command 会被拒绝。',
  'workspace-write':
    'workspace-write（读写）：可以读写工作区内文件，并可在命令白名单内执行命令。',
};

/**
 * 构造子智能体系统提示。
 * permission 参数优先；未提供时使用 task.permission；仍缺失则按最保守的 read-only 说明。
 */
export function buildAgentPrompt(task: AgentPromptTask, permission?: PermissionMode): string {
  const effectivePermission = permission ?? task.permission ?? 'read-only';
  const workspace = task.workspace !== undefined && task.workspace.length > 0
    ? task.workspace
    : '（由运行环境注入的工作区）';
  const lines: string[] = [];

  lines.push('你是「任务终端」的子智能体，正在执行一个具体任务。');
  lines.push('');
  lines.push('## 任务');
  if (task.id !== undefined && task.id.length > 0) {
    lines.push(`- 任务 ID：${task.id}`);
  }
  if (task.title !== undefined && task.title.length > 0) {
    lines.push(`- 标题：${task.title}`);
  }
  lines.push('- 目标：');
  lines.push(task.goal);
  lines.push('');
  lines.push('## 工作区与权限');
  lines.push(`- 工作区根目录：${workspace}`);
  lines.push('- 你只能访问工作区，只能通过提供的工具操作。');
  lines.push(`- 当前权限：${PERMISSION_TEXT[effectivePermission]}`);
  lines.push('');
  lines.push('## 规则');
  lines.push('1. 每完成一步就继续下一步，直到完成。');
  lines.push('2. 结束时必须调用 submit_result，包含 summary / findings / artifacts。');
  lines.push('3. 做不到就调用 submit_result 并在 summary 里说明原因，不要假装完成。');
  lines.push('4. 不要做任务目标之外的事情。');

  return lines.join('\n');
}
