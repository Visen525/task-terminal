/**
 * 任务事件流（M6-02）。
 *
 * 数据来源分两段：
 *   1. GET /tasks/:id 给出任务与最近事件，作为首屏与断线后的补漏来源；
 *   2. EventSource /events?after=<seq>&taskId=<id> 提供增量事件。
 *
 * SSE 只带 seq（id 帧）、type（event 帧）与 payload（data 帧），
 * actor/ts 不在线上传输，因此这里按事件类型推导 actor，时间戳取接收时刻；
 * 首屏历史来自 REST，字段完整。
 *
 * 性能约束：任何 SSE 消息都只进入 pending 缓冲，由 24ms 定时器合并成
 * 一次 setEvents；缓冲达到 1000 条时强刷，绝不按“每条事件一次 setState”。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  getTaskDetail,
  type Task,
  type TaskDetail as TaskDetailData,
  type TaskEvent,
} from "../api";

/** 16–32ms 合批窗口，取中间值，兼顾流畅度与主观实时性。 */
const FLUSH_INTERVAL_MS = 24;
/** 缓冲上限：超过后立即 flush，避免后台标签页 rAF/定时器停摆导致无限堆积。 */
const MAX_BUFFERED_EVENTS = 1000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 8000;

/** SPEC §4.4 的 15 种事件。EventSource 的命名事件不会触发 onmessage。 */
const SSE_EVENT_TYPES = [
  "task.created",
  "task.queued",
  "task.started",
  "agent.step",
  "llm.call",
  "agent.message",
  "agent.tool_call",
  "agent.tool_result",
  "artifact.created",
  "summary.generated",
  "budget.warning",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "memory.fact_upserted",
] as const;

export type SseStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface UseTaskEventsResult {
  task: Task | undefined;
  events: TaskEvent[];
  isLoading: boolean;
  error: Error | null;
  sseStatus: SseStatus;
  refetch: () => Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortedEvents(map: Map<number, TaskEvent>): TaskEvent[] {
  return [...map.values()].sort((left, right) => left.seq - right.seq);
}

function actorForEventType(type: string): string {
  if (type === "task.created" || type === "task.cancelled") return "user";
  if (type === "memory.fact_upserted") return "main";
  if (type === "agent.step" || type === "agent.message" || type === "agent.tool_call") {
    return "agent";
  }
  return "system";
}

/** 服务端 data 帧只有 payload；解析失败保留原文，避免静默丢事件。 */
function parsePayload(data: string): unknown {
  try {
    return JSON.parse(data) as unknown;
  } catch (error) {
    console.warn("[useTaskEvents] SSE payload 不是合法 JSON，保留原文", error);
    return { raw: data };
  }
}

function runIdOf(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  return typeof payload.run_id === "string" ? payload.run_id : null;
}

function parseSseMessage(
  taskId: string,
  type: string,
  event: MessageEvent<string>,
): TaskEvent | null {
  const seq = Number.parseInt(event.lastEventId, 10);
  if (!Number.isSafeInteger(seq) || seq <= 0) {
    console.warn("[useTaskEvents] 忽略缺少合法 seq 的 SSE 消息", { type, id: event.lastEventId });
    return null;
  }
  const payload = parsePayload(event.data);
  return {
    seq,
    taskId,
    runId: runIdOf(payload),
    ts: Date.now(),
    type,
    actor: actorForEventType(type),
    payload,
  };
}

function mergeIntoMap(map: Map<number, TaskEvent>, events: TaskEvent[]): boolean {
  let changed = false;
  for (const event of events) {
    if (map.has(event.seq)) continue;
    map.set(event.seq, event);
    changed = true;
  }
  return changed;
}

export function useTaskEvents(taskId: string): UseTaskEventsResult {
  const queryClient = useQueryClient();
  const detailQuery = useQuery({
    queryKey: ["task", taskId],
    queryFn: () => getTaskDetail(taskId),
    // 运行中的任务状态需要跟上 SSE；终态不再轮询。
    refetchInterval: (query) => {
      const status = query.state.data?.task.status;
      return status === "running" || status === "queued" || status === "waiting_input"
        ? 2500
        : false;
    },
  });

  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [sseStatus, setSseStatus] = useState<SseStatus>("connecting");
  const [isSeeded, setIsSeeded] = useState(false);

  const eventMapRef = useRef<Map<number, TaskEvent>>(new Map());
  const pendingRef = useRef<Map<number, TaskEvent>>(new Map());
  const flushTimerRef = useRef<number | null>(null);
  /** 已从 SSE 确认过的最大 seq，用于断线重连的 after 游标。 */
  const cursorRef = useRef(0);

  /** 每次 flush 只调用一次 setEvents。 */
  const flushBuffer = useCallback((): void => {
    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    if (pendingRef.current.size === 0) return;

    const pending = pendingRef.current;
    pendingRef.current = new Map();
    const changed = mergeIntoMap(eventMapRef.current, [...pending.values()]);
    if (changed) setEvents(sortedEvents(eventMapRef.current));
  }, []);

  const enqueueEvent = useCallback(
    (event: TaskEvent): void => {
      if (eventMapRef.current.has(event.seq) || pendingRef.current.has(event.seq)) return;
      pendingRef.current.set(event.seq, event);
      if (event.seq > cursorRef.current) cursorRef.current = event.seq;

      if (pendingRef.current.size >= MAX_BUFFERED_EVENTS) {
        flushBuffer();
        return;
      }
      if (flushTimerRef.current === null) {
        flushTimerRef.current = window.setTimeout(() => {
          flushTimerRef.current = null;
          flushBuffer();
        }, FLUSH_INTERVAL_MS);
      }
    },
    [flushBuffer],
  );

  /** 合并 REST 返回的事件；只有首次历史会推进重连游标。 */
  const mergeDetailEvents = useCallback((incoming: TaskEvent[], advanceCursor: boolean): void => {
    const changed = mergeIntoMap(eventMapRef.current, incoming);
    if (advanceCursor) {
      for (const event of incoming) {
        if (event.seq > cursorRef.current) cursorRef.current = event.seq;
      }
    }
    if (changed) setEvents(sortedEvents(eventMapRef.current));
  }, []);

  // 切换任务时清空所有流式状态；旧连接由下方 effect 的 cleanup 关闭。
  useEffect(() => {
    eventMapRef.current = new Map();
    pendingRef.current = new Map();
    cursorRef.current = 0;
    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    setEvents([]);
    setSseStatus("connecting");
    setIsSeeded(false);
  }, [taskId]);

  // 首次 GET 完成后播种历史；后续轮询只合并新增事件，不推进 SSE 游标。
  useEffect(() => {
    const data: TaskDetailData | undefined = detailQuery.data;
    if (data === undefined || data.task.id !== taskId) return;
    if (!isSeeded) {
      mergeDetailEvents(data.events, true);
      setIsSeeded(true);
      return;
    }
    mergeDetailEvents(data.events, false);
  }, [detailQuery.data, isSeeded, mergeDetailEvents, taskId]);

  // 事件连接生命周期：仅在首次历史就绪后启动；taskId 变化/卸载时全部关闭。
  useEffect(() => {
    if (!isSeeded) return;

    let disposed = false;
    let liveSource: EventSource | null = null;
    let backfillSource: EventSource | null = null;
    let reconnectTimer: number | null = null;
    let reconnectAttempt = 0;

    const closeBackfill = (): void => {
      backfillSource?.close();
      backfillSource = null;
    };

    const scheduleReconnect = (): void => {
      if (disposed || reconnectTimer !== null) return;
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** reconnectAttempt);
      reconnectAttempt += 1;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        void (async () => {
          if (disposed) return;
          // 先 GET 补漏（任务状态 + 最近事件），再按断线前的游标重开流。
          // 重开流从旧游标开始，断线期间超过“最近 20 条”的事件也能由 SSE 补齐。
          const resumeAfter = cursorRef.current;
          try {
            const detail = await getTaskDetail(taskId);
            if (disposed) return;
            queryClient.setQueryData(["task", taskId], detail);
            mergeDetailEvents(detail.events, false);
          } catch (error) {
            if (disposed) return;
            console.warn("[useTaskEvents] 重连前的 GET 补漏失败，稍后重试", error);
            scheduleReconnect();
            return;
          }
          if (disposed) return;
          openLive(resumeAfter);
        })();
      }, delay);
    };

    const attachHandlers = (
      source: EventSource,
      kind: "live" | "backfill",
      backfillTarget: number,
    ): void => {
      const onEvent =
        (type: string) =>
        (raw: Event): void => {
          if (disposed) return;
          const event = parseSseMessage(taskId, type, raw as MessageEvent<string>);
          if (event === null) return;
          enqueueEvent(event);
          if (kind === "backfill" && event.seq >= backfillTarget) closeBackfill();
        };

      for (const type of SSE_EVENT_TYPES) {
        source.addEventListener(type, onEvent(type));
      }
      // 命名事件不会进入 onmessage；保留默认 message 兜底，未命名 data 也不丢。
      // 注意：这里只做解析与入缓冲，绝不直接 setState。
      source.onmessage = (event: MessageEvent<string>) => {
        const parsed = parseSseMessage(taskId, "message", event);
        if (parsed !== null) enqueueEvent(parsed);
      };

      source.onopen = (): void => {
        if (disposed) return;
        if (kind === "live") {
          reconnectAttempt = 0;
          setSseStatus("open");
        }
      };

      source.onerror = (): void => {
        if (disposed) return;
        if (kind === "backfill") {
          // 回填流交给浏览器原生重连；重复事件靠 seq 去重。
          return;
        }
        setSseStatus("reconnecting");
        source.close();
        if (liveSource === source) liveSource = null;
        scheduleReconnect();
      };
    };

    const openLive = (after: number): void => {
      if (disposed) return;
      liveSource?.close();
      setSseStatus("connecting");
      const source = new EventSource(`/events?after=${after}&taskId=${encodeURIComponent(taskId)}`);
      liveSource = source;
      attachHandlers(source, "live", after);
    };

    // 首屏：GET /tasks/:id 只返回最近的 20 条事件；从 0 再拉一条回填流，
    // 补齐更早的历史后关闭，刷新页面即可看到完整时间线。
    const backfillTarget = cursorRef.current;
    if (backfillTarget > 0) {
      const source = new EventSource(`/events?after=0&taskId=${encodeURIComponent(taskId)}`);
      backfillSource = source;
      attachHandlers(source, "backfill", backfillTarget);
    }

    openLive(cursorRef.current);

    return () => {
      disposed = true;
      setSseStatus("closed");
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      liveSource?.close();
      liveSource = null;
      closeBackfill();
    };
  }, [enqueueEvent, isSeeded, mergeDetailEvents, queryClient, taskId]);

  // 卸载时清掉未触发的 flush 定时器。
  useEffect(
    () => () => {
      if (flushTimerRef.current !== null) {
        window.clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
    },
    [],
  );

  return {
    task: detailQuery.data?.task,
    events,
    isLoading: detailQuery.isLoading,
    error: detailQuery.error,
    sseStatus,
    refetch: detailQuery.refetch,
  };
}
