/**
 * 助手消息选项 chips（M10-03）。
 *
 * 只解析消息纯文本里“连续 2–6 行、同一种序号格式”的选项组：
 *   A. / A、 / A) / A）            （A–F）
 *   1. / 1、 / 1) / 1）            （1–6）
 *   ①②③④⑤⑥
 *   （一）（二）（三）              （一–六，兼容半角括号）
 * 每项去序号后必须非空且 ≤60 字符；序号需从该格式的第一个开始连续递增。
 * 解析不出来时不渲染任何节点，也不改变消息文本或发送流程。
 */
import { useState } from "react";
import { Button } from "antd";

export const OPTION_MIN_COUNT = 2;
export const OPTION_MAX_COUNT = 6;
export const OPTION_MAX_CHARS = 60;

type OptionKind = "latin" | "number" | "circled" | "chinese";

interface OptionPattern {
  kind: OptionKind;
  pattern: RegExp;
  markers: readonly string[];
}

const LATIN_MARKERS = ["A", "B", "C", "D", "E", "F"] as const;
const NUMBER_MARKERS = ["1", "2", "3", "4", "5", "6"] as const;
const CIRCLED_MARKERS = ["①", "②", "③", "④", "⑤", "⑥"] as const;
const CHINESE_MARKERS = ["一", "二", "三", "四", "五", "六"] as const;

const OPTION_PATTERNS: readonly OptionPattern[] = [
  {
    kind: "latin",
    pattern: /^([A-F])\s*[.、)）]\s*(.+)$/u,
    markers: LATIN_MARKERS,
  },
  {
    kind: "number",
    pattern: /^([1-6])\s*[.、)）]\s*(.+)$/u,
    markers: NUMBER_MARKERS,
  },
  {
    kind: "circled",
    pattern: /^([①②③④⑤⑥])\s*[.、)）]?\s*(.+)$/u,
    markers: CIRCLED_MARKERS,
  },
  {
    kind: "chinese",
    pattern: /^[（(]([一二三四五六])[）)]\s*[.、]?\s*(.+)$/u,
    markers: CHINESE_MARKERS,
  },
];

export interface OptionItem {
  marker: string;
  text: string;
}

export interface OptionGroup {
  kind: OptionKind;
  items: OptionItem[];
}

interface ParsedLine extends OptionItem {
  kind: OptionKind;
  index: number;
}

function parseOptionLine(line: string): ParsedLine | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  for (const candidate of OPTION_PATTERNS) {
    const match = candidate.pattern.exec(trimmed);
    if (match === null) continue;
    const marker = match[1] ?? "";
    const text = (match[2] ?? "").trim();
    if (text.length === 0 || [...text].length > OPTION_MAX_CHARS) return null;
    const index = candidate.markers.indexOf(marker);
    if (index < 0) return null;
    return { kind: candidate.kind, marker, text, index };
  }
  return null;
}

/**
 * 扫描整条消息，返回所有命中的选项组。
 * 空白行、普通段落、超长项或序号断档都会结束当前组，因此不会被“半个列表”误触发。
 */
export function parseOptionGroups(text: string): OptionGroup[] {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  const groups: OptionGroup[] = [];
  let current: { kind: OptionKind; items: ParsedLine[] } | null = null;

  // 选项内容常带 markdown 强调标记（**加粗** 等），chip 展示与填入前剥掉。
  const cleanText = (raw: string): string =>
    raw.replace(/\*\*|__|`/gu, "").replace(/\s+/gu, " ").trim();

  const flush = (): void => {
    if (current !== null && current.items.length >= OPTION_MIN_COUNT) {
      groups.push({
        kind: current.kind,
        items: current.items.map((item) => ({ marker: item.marker, text: cleanText(item.text) })),
      });
    }
    current = null;
  };

  for (const line of lines) {
    const parsed = parseOptionLine(line);
    if (parsed === null) {
      flush();
      continue;
    }
    if (current === null) {
      if (parsed.index === 0) current = { kind: parsed.kind, items: [parsed] };
      continue;
    }
    if (
      current.kind === parsed.kind &&
      current.items.length < OPTION_MAX_COUNT &&
      parsed.index === current.items.length
    ) {
      current.items.push(parsed);
      continue;
    }
    flush();
    if (parsed.index === 0) current = { kind: parsed.kind, items: [parsed] };
  }
  flush();
  return groups;
}

export function OptionChips({
  text,
  onPick,
}: {
  text: string;
  onPick: (text: string) => void;
}) {
  const groups = parseOptionGroups(text);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set<string>());

  if (groups.length === 0) return null;

  const pick = (id: string, value: string): void => {
    if (picked.has(id)) return;
    setPicked((previous) => {
      const next = new Set(previous);
      next.add(id);
      return next;
    });
    onPick(value);
  };

  return (
    <div className="chat-option-groups">
      {groups.map((group, groupIndex) => (
        <div
          className="chat-option-chips"
          role="group"
          aria-label={`第 ${groupIndex + 1} 组选项`}
          key={`option-group-${group.kind}-${groupIndex}`}
        >
          {group.items.map((item, itemIndex) => {
            const id = `${groupIndex}-${itemIndex}-${item.marker}`;
            const isPicked = picked.has(id);
            return (
              <Button
                key={id}
                className={isPicked ? "chat-option-chip is-picked" : "chat-option-chip"}
                size="small"
                disabled={isPicked}
                title={item.text}
                onClick={() => {
                  pick(id, item.text);
                }}
              >
                {item.text}
              </Button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
