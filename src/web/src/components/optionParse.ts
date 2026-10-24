/**
 * 选项卡片解析器（M13-03；前身 M10-03 chips 解析）。
 *
 * 只解析消息纯文本里“连续 2–6 行、同一种序号格式”的选项组：
 *   A. / A、 / A) / A）            （A–F）
 *   1. / 1、 / 1) / 1）            （1–6）
 *   ①②③④⑤⑥
 *   （一）（二）（三）              （一–六，兼容半角括号）
 * 每项去序号后必须非空且 ≤60 字符；序号需从该格式的第一个开始连续递增。
 *
 * v1.5 升级点：OptionGroup 增可选 title（组开始前最近的一行 ≤60 字符
 * 非选项文本，通常是问题句）；加粗/下划线标记剥除，反引号保留给
 * UI 层的内联代码渲染，发送值由 UI 再剥。
 * 独立成 .ts 文件以便 verify 套件直接导入测试（.tsx 含 JSX 不能被 node 断言导入）。
 */

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
  /** 组开始前最近的一行 ≤60 字符非选项文本；没有合适的标题行时缺省。 */
  title?: string;
  items: OptionItem[];
}

interface ParsedLine extends OptionItem {
  kind: OptionKind;
  index: number;
}

/** 剥 markdown 强调与标题井号，用于标题行与发送值。 */
function cleanPlain(raw: string): string {
  return raw
    .replace(/^#+\s*/u, "")
    .replace(/\*\*|__/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/** 选项正文：剥加粗/下划线；反引号保留给内联代码渲染。 */
function cleanOptionText(raw: string): string {
  return raw.replace(/\*\*|__/gu, "").replace(/\s+/gu, " ").trim();
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
  // 组标题：进入选项组前最近的一行非选项、非空、≤60 字符的文本。
  let pendingTitle: string | null = null;

  const flush = (): void => {
    if (current !== null && current.items.length >= OPTION_MIN_COUNT) {
      groups.push({
        kind: current.kind,
        ...(pendingTitle !== null && pendingTitle.length > 0
          ? { title: pendingTitle }
          : {}),
        items: current.items.map((item) => ({
          marker: item.marker,
          text: cleanOptionText(item.text),
        })),
      });
    }
    current = null;
    pendingTitle = null;
  };

  for (const line of lines) {
    const parsed = parseOptionLine(line);
    if (parsed === null) {
      flush();
      const trimmed = line.trim();
      pendingTitle =
        trimmed.length > 0 && [...trimmed].length <= OPTION_MAX_CHARS
          ? cleanPlain(trimmed)
          : null;
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

/** 发送值：在展示文本基础上去掉内联代码反引号。 */
export function optionSendValue(text: string): string {
  return text.replace(/`/gu, "");
}
