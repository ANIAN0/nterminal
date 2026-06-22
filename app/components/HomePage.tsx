'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { listWorkspaces, createWorkspace, deleteWorkspace, listConversationSources, searchRecords } from '../lib/api';
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
      // 获取对话总数
      try {
        const result = await searchRecords({ query: '*', limit: 1 });
        setTotalConversations(result.items?.length || 0);
      } catch {
        setTotalConversations(0);
      }
    } catch (err) {
      console.error('Failed to load homepage data:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleCreate = useCallback(async () => {
    if (!newPath.trim()) return;
    try {
      await createWorkspace({ cwd: newPath.trim() });
      setNewPath('');
      await loadData();
      router.push(`/terminal?path=${encodeURIComponent(newPath.trim())}`);
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

  const handleNavigate = useCallback((path: string) => {
    router.push(`/terminal?path=${encodeURIComponent(path)}`);
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
          <a href="/settings" className="ml-auto hover:text-[color:var(--color-fg-primary)]">管理 →</a>
        </div>
        {/* 主区域：空状态 */}
        <div className="flex-1 flex items-center justify-center text-[color:var(--color-fg-quaternary)] text-sm">
          选择或创建工作区以开始
        </div>
      </div>
    </div>
  );
}
