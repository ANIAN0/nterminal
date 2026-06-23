'use client';

import { useCallback } from 'react';
import type { Workspace } from '../lib/types';

interface WorkspaceSidebarProps {
  workspaces: Workspace[];
  onNavigate: (path: string) => void;
  onDelete: (id: string) => void;
  newPath: string;
  onNewPathChange: (value: string) => void;
  onCreate: () => void;
}

export default function WorkspaceSidebar({
  workspaces,
  onNavigate,
  onDelete,
  newPath,
  onNewPathChange,
  onCreate,
}: WorkspaceSidebarProps) {
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') onCreate();
  }, [onCreate]);

  return (
    <div
      className="w-[240px] border-r border-[color:var(--color-border-subtle)] bg-[color:var(--color-bg-panel)] flex flex-col"
      data-testid="workspace-sidebar"
    >
      <div className="px-3 py-2.5 border-b border-[color:var(--color-border-subtle)]">
        <span className="text-[12px] font-medium text-[color:var(--color-fg-secondary)] uppercase tracking-wider">
          工作区
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {workspaces.length === 0 && (
          <div className="px-3 py-6 text-center text-[11px] text-[color:var(--color-fg-quaternary)]">
            暂无工作区
          </div>
        )}
        {workspaces.map((ws) => (
          <div
            key={ws.id}
            className="px-3 py-2 flex items-center gap-2 hover:bg-[rgba(255,255,255,0.02)] cursor-pointer group"
            onClick={() => onNavigate(ws.id)}
            data-testid={`workspace-${ws.id}`}
          >
            <span className="flex-1 text-[12px] text-[color:var(--color-fg-primary)] truncate">
              {ws.displayName || ws.id.split(/[/\\]/).pop() || ws.id}
            </span>
            <span className="text-[10px] text-[color:var(--color-fg-quaternary)]">
              {ws.sessionCount}
            </span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onDelete(ws.id); }}
              className="opacity-0 group-hover:opacity-100 w-4 h-4 rounded text-[10px] text-[color:var(--color-fg-tertiary)] hover:text-[color:var(--color-accent-danger)]"
              title="删除"
              data-testid={`workspace-delete-${ws.id}`}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="border-t border-[color:var(--color-border-subtle)] px-3 py-2">
        <div className="flex gap-1">
          <input
            value={newPath}
            onChange={(e) => onNewPathChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入路径创建工作区..."
            className="flex-1 bg-transparent border border-[color:var(--color-border-strong)] rounded px-2 py-1 text-[11px] text-[color:var(--color-fg-primary)] outline-none"
            data-testid="path-input"
          />
          <button
            type="button"
            onClick={onCreate}
            className="px-2 py-1 text-[11px] bg-[color:var(--color-accent-primary)] text-white rounded hover:opacity-90"
            data-testid="path-submit"
          >
            添加
          </button>
        </div>
      </div>
    </div>
  );
}
