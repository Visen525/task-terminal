/**
 * 助手消息选项卡片（M13-03，对标用户截图升级 M10-03 chips）。
 *
 * 解析规则见 optionParse.ts（A–F / 1–6 / ①–⑥ / （一）–（六）四种序号）。
 * 交互升级：竖排单选卡片（圆点 + 序号 + 文本，支持内联代码样式）+
 * 组前标题行 + 先选中后点黑色胶囊「发送所选」一次发送；
 * 替代旧 chips 的逐个点击填输入框。解析不出来时不渲染任何节点。
 */
import { useState } from "react";

import { parseOptionGroups, optionSendValue, type OptionGroup } from "./optionParse";

/** 选项文本：`code` 渲染为内联代码，其余原样。 */
function OptionText({ text }: { text: string }) {
  const parts = text.split(/`([^`]+)`/gu);
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? <code key={index}>{part}</code> : <span key={index}>{part}</span>,
      )}
    </>
  );
}

function OptionCard({
  group,
  onPick,
}: {
  group: OptionGroup;
  onPick: (value: string) => void;
}) {
  const [pickedIndex, setPickedIndex] = useState<number | null>(null);
  const [sent, setSent] = useState(false);

  const send = (): void => {
    if (sent || pickedIndex === null) return;
    const item = group.items[pickedIndex];
    if (item === undefined) return;
    setSent(true);
    // 发送值带序号（如 "B. false"），中文序号还原括号（如 "（二）甲"）。
    const clean = optionSendValue(item.text);
    onPick(group.kind === "chinese" ? `（${item.marker}）${clean}` : `${item.marker}. ${clean}`);
  };

  return (
    <section className="chat-option-card">
      {group.title === undefined ? null : (
        <div className="chat-option-card-title">{group.title}</div>
      )}
      <div className="chat-option-card-items" role="radiogroup">
        {group.items.map((item, itemIndex) => {
          const isPicked = pickedIndex === itemIndex;
          return (
            <button
              key={`${item.marker}-${itemIndex}`}
              type="button"
              role="radio"
              aria-checked={isPicked}
              className={isPicked ? "chat-option-item is-picked" : "chat-option-item"}
              disabled={sent}
              title={item.text}
              onClick={() => {
                if (!sent) setPickedIndex(itemIndex);
              }}
            >
              <span className="chat-option-radio" aria-hidden />
              <span className="chat-option-marker">{item.marker}.</span>
              <span className="chat-option-text">
                <OptionText text={item.text} />
              </span>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        className="chat-option-send"
        disabled={sent || pickedIndex === null}
        onClick={send}
      >
        {sent ? "已发送" : "发送所选"}
      </button>
    </section>
  );
}

export function OptionCards({
  text,
  onPick,
}: {
  text: string;
  onPick: (value: string) => void;
}) {
  const groups = parseOptionGroups(text);
  if (groups.length === 0) return null;
  return (
    <div className="chat-option-groups">
      {groups.map((group, groupIndex) => (
        <OptionCard key={`option-card-${groupIndex}`} group={group} onPick={onPick} />
      ))}
    </div>
  );
}
