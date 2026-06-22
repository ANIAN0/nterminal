'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { listWorkspaces, createWorkspace, deleteWorkspace, listConversationSources, createSession } from '../lib/api';
import type { Workspace, ConversationSource } from '../lib/types';
import WorkspaceSidebar from './WorkspaceSidebar';

export default function HomePage() {
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [sources, setSources] = useState<ConversationSource[]>([]);
  const [totalConversations, setTotalConversations] = useState(0);
  const [loading, setLoading] = useState(true);
  const [newPath, setNewPath] = useState('');

  const loadData = useCallback(async () => {
    try {
      const [ws, src] = await Promise.all([
        listWorkspaces(),
        listConversationSources(),
      ]);
      setWorkspaces(ws);
      setSources(src.items || []);
      setTotalConversations((src.items || []).reduce((sum, source) => sum + source.recordCount, 0));
    } catch (err) {
      console.error('Failed to load homepage data:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // 首屏加载延迟到微任务执行，避免 effect 内同步触发状态更新。
    queueMicrotask(() => { void loadData(); });
  }, [loadData]);

  const handleCreate = useCallback(async () => {
    if (!newPath.trim()) return;
    try {
      const cwd = newPath.trim();
      await createWorkspace({ cwd });
      const { session } = await createSession({ cwd });
      setNewPath('');
      await loadData();
      router.push(`/terminal?sessionId=${encodeURIComponent(session.id)}`);
    } catch (err) {
      alert(err instanceof Error ? err.message : '创建工作区失败');
    }
  }, [newPath, loadData, router]);

  const handleDelete = useCallback(async (id: string) => {
    if (!confirm('确定删除工作区？')) return;
    try {
      await deleteWorkspace({ id });
      await loadData();
    } catch (err) {
      alert(err instanceof Error ? err.message : '删除失败');
    }
  }, [loadData]);

  const handleNavigate = useCallback(async (path: string) => {
    try {
      const { session } = await createSession({ cwd: path });
      router.push(`/terminal?sessionId=${encodeURIComponent(session.id)}`);
    } catch (err) {
      alert(err instanceof Error ? err.message : '创建终端失败');
    }
  }, [router]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen text-[color:var(--color-fg-tertiary)]">
        加载中...
      </div>
    );
  }

  return (
    <div className="flex h-screen">
      <WorkspaceSidebar
        workspaces={workspaces}
        onNavigate={handleNavigate}
        onDelete={handleDelete}
        newPath={newPath}
        onNewPathChange={setNewPath}
        onCreate={handleCreate}
      />
      <div className="flex-1 flex flex-col">
        {/* 顶部状态行 */}
        <div className="h-10 border-b border-[color:var(--color-border-subtle)] flex items-center px-4 text-[11px] text-[color:var(--color-fg-tertiary)] gap-4">
          <span>已发现 {sources.length} 个对话源</span>
          <span>已导入 {totalConversations} 条对话</span>
          <Link href="/settings" className="ml-auto hover:text-[color:var(--color-fg-primary)]">管理 →</Link>
        </div>
        {/* 主区域：空状态 */}
        <div className="flex-1 flex items-center justify-center text-[color:var(--color-fg-quaternary)] text-sm">
          选择或创建工作区以开始
        </div>
      </div>
    </div>
  );
}
