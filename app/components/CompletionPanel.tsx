'use client';

import { useEffect, useRef } from 'react';
import type { CompletionItem } from '../lib/types';

interface CompletionPanelProps {
  items: CompletionItem[];
  onSelect: (text: string) => void;
  onCancel: () => void;
  onHover?: (index: number) => void;
  highlightedIndex: number;
}

/**
 * 补全面板组件
 * 在输入框下方展示补全建议，支持键盘和鼠标交互
 */
export default function CompletionPanel({
  items,
  onSelect,
  onCancel,
  onHover,
  highlightedIndex,
}: CompletionPanelProps) {
  const listRef = useRef<HTMLUListElement>(null);

  // 高亮项滚动到可视区
  useEffect(() => {
    if (listRef.current && highlightedIndex >= 0) {
      const item = listRef.current.children[highlightedIndex] as HTMLElement;
      item?.scrollIntoView({ block: 'nearest' });
    }
  }, [highlightedIndex]);

  if (items.length === 0) return null;

  return (
    <ul
      ref={listRef}
      className="py-1 max-h-[240px] overflow-y-auto"
      role="listbox"
      data-testid="completion-list"
    >
      {items.map((item, index) => (
        <li
          key={item.userText + index}
          role="option"
          aria-selected={index === highlightedIndex}
          className={`px-3 py-1.5 cursor-pointer flex items-center gap-2 text-[13px] transition-colors ${
            index === highlightedIndex
              ? 'bg-[rgba(165,213,254,0.12)] text-[color:var(--color-fg-primary)]'
              : 'text-[color:var(--color-fg-secondary)] hover:bg-[rgba(165,213,254,0.06)]'
          }`}
          onClick={() => onSelect(item.userText)}
          // 鼠标 hover 通知父组件同步高亮（与键盘互通）
          onMouseEnter={() => onHover?.(index)}
          data-testid={`completion-item-${index}`}
        >
          <span className="truncate flex-1 mono">{item.userText}</span>
          <span className="chip text-[10px] text-[color:var(--color-fg-tertiary)] shrink-0">
            ×{item.count}
          </span>
        </li>
      ))}
    </ul>
  );
}
