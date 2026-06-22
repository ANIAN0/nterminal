'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  listConversationSources,
  addConversationSource,
  removeConversationSource,
  syncConversationSource,
} from '../lib/api';
import type { ConversationSource } from '../lib/types';

type Status = 'idle' | 'adding' | 'removing' | 'syncing' | 'error';

/**
 * 设置页 — 对话源配置
 * 添加/移除/同步对话源
 */
export default function SettingsPage() {
  const router = useRouter();
  const [sources, setSources] = useState<ConversationSource[]>([]);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);

  // 表单状态
  const [path, setPath] = useState('');
  const [agentType, setAgentType] = useState<'claude' | 'pi' | 'codex'>('claude');
  const [label, setLabel] = useState('');

  const loadSources = useCallback(async () => {
    try {
      const { items } = await listConversationSources();
      setSources(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载对话源失败');
    }
  }, []);

  useEffect(() => {
    loadSources();
  }, [loadSources]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus('adding');
    setError(null);
    try {
      await addConversationSource({ path, agentType, label: label || undefined });
      setPath('');
      setLabel('');
      await loadSources();
      setStatus('idle');
    } catch (err) {
      setError(err instanceof Error ? err.message : '添加失败');
      setStatus('error');
    }
  };

  const handleRemove = async (id: string) => {
    if (!confirm('确定移除此对话源？已导入的数据不会被删除。')) return;
    setStatus('removing');
    setError(null);
    try {
      await removeConversationSource(id);
      await loadSources();
      setStatus('idle');
    } catch (err) {
      setError(err instanceof Error ? err.message : '移除失败');
      setStatus('error');
    }
  };

  const handleSync = async (id: string) => {
    setStatus('syncing');
    setError(null);
    try {
      const result = await syncConversationSource(id);
      alert(`同步完成：导入 ${result.importedCount} 条，跳过 ${result.skippedCount} 条`);
      await loadSources();
      setStatus('idle');
    } catch (err) {
      setError(err instanceof Error ? err.message : '同步失败');
      setStatus('error');
    }
  };

  const statusColor = (s: string) => {
    switch (s) {
      case 'active':
        return 'text-[color:var(--color-status-running)]';
      case 'error':
        return 'text-[color:var(--color-status-error)]';
      default:
        return 'text-[color:var(--color-fg-tertiary)]';
    }
  };

  return (
    <div className="min-h-screen w-full flex flex-col">
      <header className="w-full px-6 py-4 flex items-center justify-between border-b border-[color:var(--color-border-subtle)]">
        <div className="flex items-center gap-2.5">
          <a href="/" className="flex items-center gap-2 text-sm hover:opacity-80 transition-opacity">
            <Logo />
            <span className="font-semibold tracking-tight">nterminal</span>
          </a>
          <span className="text-[color:var(--color-fg-quaternary)] text-xs">·</span>
          <h1 className="text-sm text-[color:var(--color-fg-secondary)]">设置</h1>
        </div>
        <a href="/" className="nav-link" data-testid="back-home">
          ← 返回
        </a>
      </header>

      <main className="flex-1 w-full max-w-3xl mx-auto px-6 py-8 flex flex-col gap-8">
        {/* 错误提示 */}
        {error && (
          <div
            role="alert"
            className="flex items-center gap-2 text-[13px] text-[color:var(--color-accent-danger)] bg-[rgba(255,130,114,0.06)] border border-[rgba(255,130,114,0.25)] rounded-lg px-3 py-2"
            data-testid="error-banner"
          >
            <span>{error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              className="ml-auto underline text-xs"
            >
              关闭
            </button>
          </div>
        )}

        {/* 添加对话源表单 */}
        <section className="glass-panel p-5">
          <h2 className="text-lg font-semibold tracking-tight mb-4">添加对话源</h2>
          <form onSubmit={handleAdd} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-[12px] text-[color:var(--color-fg-secondary)]">
                对话源路径
              </label>
              <input
                type="text"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="例如：~/.claude 或 /path/to/sessions"
                className="input-mono"
                data-testid="source-path"
                required
              />
            </div>

            <div className="flex gap-4">
              <div className="flex flex-col gap-1.5 flex-1">
                <label className="text-[12px] text-[color:var(--color-fg-secondary)]">
                  Agent 类型
                </label>
                <select
                  value={agentType}
                  onChange={(e) => setAgentType(e.target.value as 'claude' | 'pi' | 'codex')}
                  className="input-mono"
                  data-testid="source-agent-type"
                >
                  <option value="claude">Claude Code</option>
                  <option value="pi">pi-mono</option>
                  <option value="codex">Codex</option>
                </select>
              </div>

              <div className="flex flex-col gap-1.5 flex-1">
                <label className="text-[12px] text-[color:var(--color-fg-secondary)]">
                  标签（可选）
                </label>
                <input
                  type="text"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="My Claude"
                  className="input-mono"
                  data-testid="source-label"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={status === 'adding' || !path}
              className="btn-primary self-start"
              data-testid="add-source"
            >
              {status === 'adding' ? '添加中…' : '添加对话源'}
            </button>
          </form>
        </section>

        {/* 对话源列表 */}
        <section>
          <h2 className="text-lg font-semibold tracking-tight mb-3">对话源列表</h2>
          {sources.length === 0 ? (
            <div className="glass-panel px-4 py-8 text-center" data-testid="empty-sources">
              <div className="text-sm text-[color:var(--color-fg-secondary)]">
                暂无对话源
              </div>
              <div className="text-xs text-[color:var(--color-fg-tertiary)] mt-1">
                添加本地 agent 对话文件路径以导入历史
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2" data-testid="sources-list">
              {sources.map((source) => (
                <div
                  key={source.id}
                  className="glass-panel px-4 py-3 flex items-center gap-4"
                  data-testid={`source-item-${source.id}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="chip text-[10px] mono">{source.agentType}</span>
                      {source.label && (
                        <span className="text-[12px] text-[color:var(--color-fg-primary)]">
                          {source.label}
                        </span>
                      )}
                      <span className={`text-[10px] ${statusColor(source.status)}`}>
                        {source.status}
                      </span>
                    </div>
                    <div
                      className="text-[11px] text-[color:var(--color-fg-tertiary)] mono truncate"
                      title={source.path}
                    >
                      {source.path}
                    </div>
                    <div className="text-[10px] text-[color:var(--color-fg-quaternary)] mt-1">
                      {source.recordCount} 条记录
                      {source.lastSyncedAt &&
                        ` · 最后同步：${new Date(source.lastSyncedAt).toLocaleString()}`}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleSync(source.id)}
                      disabled={status === 'syncing'}
                      className="btn-ghost text-xs"
                      data-testid={`sync-source-${source.id}`}
                    >
                      {status === 'syncing' ? '同步中…' : '同步'}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRemove(source.id)}
                      disabled={status === 'removing'}
                      className="btn-ghost text-xs text-[color:var(--color-accent-danger)]"
                      data-testid={`remove-source-${source.id}`}
                    >
                      移除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function Logo() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="2" y="3" width="20" height="14" rx="2.5" stroke="var(--color-accent)" strokeWidth="1.5" />
      <path
        d="M6 9 L9.5 12 L6 15"
        stroke="var(--color-accent-2)"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <line
        x1="11"
        y1="15"
        x2="15"
        y2="15"
        stroke="var(--color-accent-warn)"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
