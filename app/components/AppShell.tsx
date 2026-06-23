'use client';

/**
 * 应用总壳。
 * 负责把 WorkspaceProvider / TerminalConnectionProvider 注入到子树，并渲染侧边栏 + 主内容区。
 * 所有页面都通过 layout.tsx 被它包裹，避免每个页面重复挂载 Provider。
 */

import Link from 'next/link';
import { TerminalConnectionProvider } from './TerminalConnectionProvider';
import { WorkspaceProvider, useWorkspace } from './WorkspaceProvider';

function ShellContent({ children }: { children: React.ReactNode }) {
  const { workspaces, error } = useWorkspace();
  return (
    <div className="flex min-h-screen bg-[color:var(--color-bg-base)]">
      <aside className="w-60 border-r border-[color:var(--color-border-subtle)] flex flex-col" data-testid="workspace-sidebar">
        <nav className="p-3 flex flex-col gap-2">
          <Link href="/">概览</Link>
          <Link href="/history">历史</Link>
          <Link href="/settings">设置</Link>
        </nav>
        <div className="border-t border-[color:var(--color-border-subtle)] p-3 text-xs">工作区</div>
        <div className="flex-1 overflow-auto px-3">
          {workspaces.map((workspace) => (
            <div key={workspace.id} className="truncate py-1">{workspace.displayName || workspace.id}</div>
          ))}
          {error && <p role="alert" className="text-red-500">{error}</p>}
        </div>
      </aside>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <WorkspaceProvider>
      <TerminalConnectionProvider>
        <ShellContent>{children}</ShellContent>
      </TerminalConnectionProvider>
    </WorkspaceProvider>
  );
}
