'use client';

import { useRef, useState } from 'react';
import type { TabInfo } from '../lib/types';
import { MAX_TABS } from '../lib/types';

interface TabBarProps {
  tabs: TabInfo[];
  activeTabId: string;
  onTabSelect: (id: string) => void;
  onTabClose: (id: string) => void;
  onTabCreate: () => void;
}

/**
 * 标签栏组件
 * 顶部水平标签栏，支持创建/切换/关闭，最多 8 个标签
 */
export default function TabBar({
  tabs,
  activeTabId,
  onTabSelect,
  onTabClose,
  onTabCreate,
}: TabBarProps) {
  const [hoveredTab, setHoveredTab] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const canCreate = tabs.length < MAX_TABS;

  return (
    <div
      className="flex items-center gap-0.5 px-2 py-1 border-b border-[color:var(--color-border-subtle)] bg-[color:var(--color-bg-panel)] overflow-x-auto"
      data-testid="tab-bar"
    >
      <div ref={scrollRef} className="flex items-center gap-0.5 flex-1 min-w-0">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const isHovered = hoveredTab === tab.id;

          return (
            <div
              key={tab.id}
              className={`group flex items-center gap-1.5 px-3 py-1 rounded-md text-[12px] cursor-pointer transition-colors select-none shrink-0 ${
                isActive
                  ? 'bg-[color:var(--color-bg-panel-strong)] text-[color:var(--color-fg-primary)] border border-[color:var(--color-border-strong)]'
                  : 'text-[color:var(--color-fg-secondary)] hover:bg-[rgba(255,255,255,0.04)] border border-transparent'
              }`}
              onClick={() => onTabSelect(tab.id)}
              onMouseEnter={() => setHoveredTab(tab.id)}
              onMouseLeave={() => setHoveredTab(null)}
              data-testid={`tab-${tab.id}`}
              title={tab.label}
            >
              {/* 状态指示器 */}
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  tab.status === 'ready'
                    ? 'bg-[color:var(--color-status-running)]'
                    : 'bg-[color:var(--color-fg-quaternary)] animate-pulse'
                }`}
              />
              <span className="truncate max-w-[120px]">{tab.label}</span>
              {/* 关闭按钮 */}
              <button
                type="button"
                className={`ml-0.5 w-4 h-4 rounded flex items-center justify-center text-[10px] transition-opacity ${
                  isHovered || isActive
                    ? 'opacity-100'
                    : 'opacity-0 group-hover:opacity-100'
                } hover:bg-[rgba(255,255,255,0.1)] text-[color:var(--color-fg-tertiary)] hover:text-[color:var(--color-fg-primary)]`}
                onClick={(e) => {
                  e.stopPropagation();
                  onTabClose(tab.id);
                }}
                aria-label={`关闭 ${tab.label}`}
                data-testid={`tab-close-${tab.id}`}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>

      {/* 新建标签按钮 */}
      <button
        type="button"
        onClick={onTabCreate}
        disabled={!canCreate}
        className={`shrink-0 w-6 h-6 rounded flex items-center justify-center text-[14px] transition-colors ${
          canCreate
            ? 'text-[color:var(--color-fg-tertiary)] hover:text-[color:var(--color-fg-primary)] hover:bg-[rgba(255,255,255,0.06)]'
            : 'text-[color:var(--color-fg-quaternary)] cursor-not-allowed opacity-40'
        }`}
        title={canCreate ? '新建标签' : `最多 ${MAX_TABS} 个标签`}
        data-testid="tab-create"
      >
        +
      </button>
    </div>
  );
}
