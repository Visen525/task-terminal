/**
 * 崩溃恢复 reaper（SPEC §4.3 / §7 M4-01）。
 *
 * 启动时扫描租约过期的 running run：
 * - 先收 run（interrupted），再补 task.failed{reason:'interrupted'}，最后才推进任务表；
 * - attempt < 3 时任务经 failed → queued 回到队列（事件流同时补 task.queued，
 *   foldEvents 据此把 attempt 递增到下一次执行）；
 * - attempt 用尽只到 failed 为止；
 * - 任务已不在 running 的孤儿 run 只收 run，不发任务事件、不改任务表。
 *
 * 事件先于表状态写入：即使进程在两者之间再次崩溃，下一次 reaper 仍能以
 * 事件流为准重建；绝不做“静默改状态”。本文件不启动 loop。
 */
import type { DatabaseSync } from 'node:sqlite';

import type { TaskRun } from '../core/types.ts';
import { appendEvent } from '../store/events.ts';
import { finishRun, getTask, updateTaskStatus } from '../store/repo.ts';

/** SPEC §4.3：失败任务最多尝试 3 次。 */
export const MAX_REAP_ATTEMPTS = 3;

interface ExpiredRunRow {
  id: string;
  task_id: string;
  attempt: number;
  status: string;
  lease_until: number;
  steps: number;
  error: string | null;
  started_at: number;
  ended_at: number | null;
  task_status: string;
}

/**
 * 扫描 `runs.status='running' AND lease_until < now` 的过期运行并恢复。
 * 返回本次处理的 run 列表（已收为 interrupted，按 lease_until、id 升序）。
 */
export function reapExpiredRuns(db: DatabaseSync, now: number = Date.now()): TaskRun[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.task_id, r.attempt, r.status, r.lease_until, r.steps,
              r.error, r.started_at, r.ended_at, t.status AS task_status
         FROM runs r
         JOIN tasks t ON t.id = r.task_id
        WHERE r.status = 'running' AND r.lease_until < ?
        ORDER BY r.lease_until ASC, r.id ASC`,
    )
    .all(now) as unknown as ExpiredRunRow[];

  const reaped: TaskRun[] = [];
  for (const row of rows) {
    // 1) run 先收为 interrupted；任务事件/表状态随后按任务当前状态决定。
    const run = finishRun(db, row.id, 'interrupted', { now });

    const task = getTask(db, row.task_id);
    if (task === null || task.status !== 'running') {
      // 孤儿 run：任务已终态或已被别的路径收尾，只收 run，不碰任务。
      reaped.push(run);
      continue;
    }

    // 2) 补 closer 事件（唯一真相源），再推进表。
    appendEvent(db, {
      taskId: task.id,
      runId: run.id,
      type: 'task.failed',
      actor: 'system',
      payload: { reason: 'interrupted', attempt: row.attempt },
      ts: now,
    });

    if (row.attempt < MAX_REAP_ATTEMPTS) {
      appendEvent(db, {
        taskId: task.id,
        runId: null,
        type: 'task.queued',
        actor: 'system',
        payload: {},
        ts: now,
      });
      updateTaskStatus(db, task.id, 'failed', { now });
      updateTaskStatus(db, task.id, 'queued', { now });
    } else {
      updateTaskStatus(db, task.id, 'failed', { now });
    }

    reaped.push(run);
  }

  return reaped;
}
