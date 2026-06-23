'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  addConversationSource,
  listConversationSources,
  removeConversationSource,
  syncConversationSource,
} from '../lib/api';
import type { ConversationSource } from '../lib/types';

type Status = 'idle' | 'adding' | 'removing' | 'error';

type AgentType = 'claude' | 'pi' | 'codex' | 'opencode';

/**
 * 设置页负责维护本地对话源；每个来源独立 pending，避免单点失败影响其他来源操作。
 */
export default function SettingsPage() {
  const [sources, setSources] = useState<ConversationSource[]>([]);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [pendingActions, setPendingActions] = useState<Set<string>>(new Set());
  const [syncingAll, setSyncingAll] = useState(false);
  const [path, setPath] = useState('');
  const [agentType, setAgentType] = useState<AgentType>('claude');
  const [label, setLabel] = useState('');

  const loadSources = useCallback(async () => {
    try {
      const { items } = await listConversationSources();
      setSources(items);
    } catch {
      setError('加载对话源失败');
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => { void loadSources(); });
  }, [loadSources]);

  const handleAdd = async (event: React.FormEvent) => {
    event.preventDefault();
    setStatus('adding');
    setError(null);
    try {
      await addConversationSource({ path, agentType, label: label || undefined });
      setPath('');
      setLabel('');
      await loadSources();
      setStatus('idle');
    } catch {
      setError('添加对话源失败');
      setStatus('error');
    }
  };

  const handleRemove = async (id: string) => {
    if (confirmRemoveId !== id) {
      setConfirmRemoveId(id);
      return;
    }
    setStatus('removing');
    setError(null);
    try {
      await removeConversationSource(id);
      await loadSources();
      setConfirmRemoveId(null);
      setStatus('idle');
    } catch {
      setError('移除对话源失败');
      setStatus('error');
    }
  };

  const handleSync = async (id: string) => {
    const actionKey = `sync:${id}`;
    if (pendingActions.has(actionKey)) return;
    setPendingActions((current) => new Set(current).add(actionKey));
    setError(null);
    try {
      const result = await syncConversationSource(id);
      setNotice(`同步完成：写入 ${result.inserted} 条${result.skipped ? '，来源无变化' : ''}`);
      await loadSources();
    } catch {
      setError('同步对话源失败');
    } finally {
      setPendingActions((current) => {
        const next = new Set(current);
        next.delete(actionKey);
        return next;
      });
    }
  };

  const handleSyncAll = async () => {
    if (syncingAll || sources.length === 0) return;
    setSyncingAll(true);
    setError(null);
    setPendingActions(new Set(sources.map((source) => `sync:${source.id}`)));
    try {
      const results = await Promise.allSettled(sources.map((source) => syncConversationSource(source.id)));
      const okCount = results.filter((result) => result.status === 'fulfilled' && result.value.state === 'active').length;
      const failedCount = results.length - okCount;
      setNotice(`同步全部完成：成功 ${okCount} 个，失败 ${failedCount} 个`);
      await loadSources();
    } catch {
      setError('同步全部失败');
    } finally {
      setSyncingAll(false);
      setPendingActions(new Set());
    }
  };

  const statusColor = (sourceStatus: string) => {
    switch (sourceStatus) {
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
          <Link href="/" className="flex items-center gap-2 text-sm hover:opacity-80 transition-opacity">
            <Logo />
            <span className="font-semibold tracking-tight">nterminal</span>
          </Link>
          <span className="text-[color:var(--color-fg-quaternary)] text-xs">/</span>
          <h1 className="text-sm text-[color:var(--color-fg-secondary)]">设置</h1>
        </div>
        <Link href="/" className="nav-link" data-testid="back-home">← 返回</Link>
      </header>

      <main className="flex-1 w-full max-w-3xl mx-auto px-6 py-8 flex flex-col gap-8">
        {error && (
          <div
            role="alert"
            className="flex items-center gap-2 text-[13px] text-[color:var(--color-accent-danger)] bg-[rgba(255,130,114,0.06)] border border-[rgba(255,130,114,0.25)] rounded-lg px-3 py-2"
            data-testid="error-banner"
          >
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)} className="ml-auto underline text-xs">关闭</button>
          </div>
        )}
        {notice && <div role="status" className="rounded border px-3 py-2 text-sm">{notice}</div>}

        <section className="glass-panel p-5">
          <h2 className="text-lg font-semibold tracking-tight mb-4">添加对话源</h2>
          <form onSubmit={handleAdd} className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5 text-[12px] text-[color:var(--color-fg-secondary)]">
              对话源路径
              <input
                type="text"
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder="例如：~/.claude 或 /path/to/sessions"
                className="input-mono"
                data-testid="source-path"
                required
              />
            </label>

            <div className="flex gap-4">
              <label className="flex flex-col gap-1.5 flex-1 text-[12px] text-[color:var(--color-fg-secondary)]">
                Agent 类型
                <select
                  value={agentType}
                  onChange={(event) => setAgentType(event.target.value as AgentType)}
                  className="input-mono"
                  data-testid="source-agent-type"
                >
                  <option value="claude">Claude Code</option>
                  <option value="pi">pi-mono</option>
                  <option value="codex">Codex</option>
                  <option value="opencode">OpenCode</option>
                </select>
              </label>

              <label className="flex flex-col gap-1.5 flex-1 text-[12px] text-[color:var(--color-fg-secondary)]">
                标签（可选）
                <input
                  type="text"
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder="My Claude"
                  className="input-mono"
                  data-testid="source-label"
                />
              </label>
            </div>

            <button type="submit" disabled={status === 'adding' || !path} className="btn-primary self-start" data-testid="add-source">
              {status === 'adding' ? '添加中…' : '添加对话源'}
            </button>
          </form>
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold tracking-tight">对话源列表</h2>
            {sources.length > 0 && (
              <button type="button" className="btn-ghost text-xs" disabled={syncingAll} onClick={handleSyncAll}>
                {syncingAll ? '同步全部中…' : '同步全部'}
              </button>
            )}
          </div>

          {sources.length === 0 ? (
            <div className="glass-panel px-4 py-8 text-center" data-testid="empty-sources">
              <div className="text-sm text-[color:var(--color-fg-secondary)]">暂无对话源</div>
              <div className="text-xs text-[color:var(--color-fg-tertiary)] mt-1">添加本地 agent 对话文件路径以导入历史</div>
            </div>
          ) : (
            <div className="flex flex-col gap-2" data-testid="sources-list">
              {sources.map((source) => {
                const syncPending = pendingActions.has(`sync:${source.id}`);
                return (
                  <div key={source.id} className="glass-panel px-4 py-3 flex items-center gap-4" data-testid={`source-item-${source.id}`}>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="chip text-[10px] mono">{source.agentType}</span>
                        {source.label && <span className="text-[12px] text-[color:var(--color-fg-primary)]">{source.label}</span>}
                        <span className={`text-[10px] ${statusColor(source.status)}`}>{source.status}</span>
                      </div>
                      <div className="text-[11px] text-[color:var(--color-fg-tertiary)] mono truncate" title={source.path}>{source.path}</div>
                      <div className="text-[10px] text-[color:var(--color-fg-quaternary)] mt-1">
                        {source.recordCount} 条记录
                        {source.lastSuccessAt
                          ? ` · 最后成功：${new Date(source.lastSuccessAt).toLocaleString()}`
                          : source.lastSyncedAt
                            ? ` · 最后同步：${new Date(source.lastSyncedAt).toLocaleString()}`
                            : ''}
                      </div>
                      {source.status === 'error' && (
                        <div className="mt-2 rounded border border-[color:var(--color-accent-danger)]/30 px-2 py-1 text-[11px] text-[color:var(--color-accent-danger)]">
                          <span className="mono mr-2">{source.lastErrorCode || 'SOURCE_ERROR'}</span>
                          <span>{source.lastErrorMessage || '来源同步失败，可重试'}</span>
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => handleSync(source.id)}
                        disabled={syncPending}
                        className="btn-ghost text-xs"
                        data-testid={`sync-source-${source.id}`}
                      >
                        {syncPending ? '同步中…' : source.status === 'error' ? '重试' : '同步'}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRemove(source.id)}
                        disabled={status === 'removing'}
                        className="btn-ghost text-xs text-[color:var(--color-accent-danger)]"
                        data-testid={`remove-source-${source.id}`}
                      >
                        {confirmRemoveId === source.id ? '再次点击确认' : '移除'}
                      </button>
                    </div>
                  </div>
                );
              })}
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
      <path d="M6 9 L9.5 12 L6 15" stroke="var(--color-accent-2)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <line x1="11" y1="15" x2="15" y2="15" stroke="var(--color-accent-warn)" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
