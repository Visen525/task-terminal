/**
 * 划选引用按钮（M10-03）。
 *
 * 选区识别与坐标计算在 Chat 页面完成：这里只负责把视口坐标钳制到边缘内，
 * 并用 fixed 定位把按钮浮在选区上方（上方放不下时放到下方）。
 * 按钮自身不改变选区，点击前由 Chat 读取已缓存的纯文本。
 */
import { Button } from "antd";
import { MessageOutlined } from "@ant-design/icons";

export const SELECTION_QUOTE_MAX_CHARS = 200;
export const SELECTION_QUOTE_BUTTON_WIDTH = 104;
export const SELECTION_QUOTE_BUTTON_HEIGHT = 30;
export const SELECTION_QUOTE_VIEWPORT_GAP = 8;

export interface SelectionButtonPosition {
  top: number;
  left: number;
}

/** 选中文本按 Unicode 码点截断，超出 200 字符补 …，并保留换行供引用块使用。 */
export function truncateQuoteSelection(
  text: string,
  maxChars = SELECTION_QUOTE_MAX_CHARS,
): string {
  const normalized = text.replace(/\r\n?/gu, "\n").trim();
  const chars = [...normalized];
  if (chars.length <= maxChars) return normalized;
  return `${chars.slice(0, maxChars).join("")}…`;
}

/**
 * 把按钮放在选区上方并保持在视口内：
 * 横向以选区中心对齐后钳制到 [gap, viewport - button - gap]；
 * 上方空间不足时改放选区下方，同样钳制底部。
 */
export function clampSelectionButtonPosition(
  rect: Pick<DOMRect, "top" | "left" | "bottom" | "width" | "height">,
  viewport: { width: number; height: number },
  button: { width: number; height: number } = {
    width: SELECTION_QUOTE_BUTTON_WIDTH,
    height: SELECTION_QUOTE_BUTTON_HEIGHT,
  },
): SelectionButtonPosition {
  const gap = SELECTION_QUOTE_VIEWPORT_GAP;
  const maxLeft = Math.max(gap, viewport.width - button.width - gap);
  const left = Math.min(
    Math.max(rect.left + rect.width / 2 - button.width / 2, gap),
    maxLeft,
  );

  const above = rect.top - button.height - gap;
  if (above >= gap) return { top: above, left };

  const maxTop = Math.max(gap, viewport.height - button.height - gap);
  const below = rect.bottom + gap;
  return { top: Math.min(Math.max(below, gap), maxTop), left };
}

export function SelectionQuoteButton({
  position,
  onClick,
}: {
  position: SelectionButtonPosition;
  onClick: () => void;
}) {
  return (
    <div
      className="chat-selection-quote"
      data-selection-quote-button="true"
      style={{ top: position.top, left: position.left }}
      onMouseDown={(event) => {
        // 阻止默认行为，保住选区；否则 mousedown 会先折叠选区导致按钮消失。
        event.preventDefault();
      }}
    >
      <Button
        type="primary"
        size="small"
        icon={<MessageOutlined />}
        aria-label="引用所选"
        onClick={onClick}
      >
        引用所选
      </Button>
    </div>
  );
}
