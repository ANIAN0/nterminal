'use client';

/**
 * 历史会话浏览页。
 * 按 sourceId/cwd 聚合展示对话来源下的会话列表，支持短/长查询；同步错误的来源会高亮展示。
 */

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { listHistorySessions } from '../lib/api';
import type { HistorySessionsResponse } from '../lib/types';

function formatTime(value: string | null): string {
  if (!value) return '时间未知';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export default function HistoryPage() {
  const [history, setHistory] = useState<HistorySessionsResponse | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((value: string) => {
    setError(null);
    listHistorySessions({ query: value.trim() || '*', limit: 50 })
      .then((result) => setHistory(result))
      .catch((err) => setError(err instanceof Error ? err.message : '加载历史失败'));
  }, []);

  useEffect(() => {
    // 初次加载放在异步回调中，避免 effect 内同步级联更新。
    listHistorySessions({ query: '*', limit: 50 })
      .then((result) => setHistory(result))
      .catch((err) => setError(err instanceof Error ? err.message : '加载历史失败'));
  }, []);

  return (
    <main className="min-h-screen bg-[color:var(--color-bg-primary)] text-[color:var(--color-fg-primary)]">
      <header className="h-12 border-b border-[color:var(--color-border-subtle)] px-5 flex items-center gap-4">
        <Link href="/" className="text-sm hover:text-[color:var(--color-accent)]">nterminal</Link>
        <span className="text-sm text-[color:var(--color-fg-secondary)]">对话历史</span>
      </header>

      <div className="max-w-4xl mx-auto p-5">
        <form
          className="flex gap-2 mb-5"
          onSubmit={(event) => { event.preventDefault(); load(query); }}
        >
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索会话、消息或工具内容"
            className="flex-1 rounded border border-[color:var(--color-border-strong)] bg-transparent px-3 py-2 text-sm outline-none"
          />
          <button type="submit" className="rounded bg-[color:var(--color-accent-primary)] px-4 py-2 text-sm text-white">
            搜索
          </button>
        </form>

        {error && <p className="mb-4 text-sm text-[color:var(--color-accent-danger)]">{error}</p>}
        {history?.sourceStates.some((source) => source.state === 'error') && (
          <div className="mb-4 space-y-2">
            {history.sourceStates.filter((source) => source.state === 'error').map((source) => (
              <div key={source.sourceId} className="rounded border border-[color:var(--color-accent-danger)]/40 p-3 text-sm text-[color:var(--color-accent-danger)]">
                <strong className="mr-2">{source.label || source.agentType}</strong>
                <span>{source.errorMessage || '来源同步失败'}</span>
              </div>
            ))}
          </div>
        )}

        <div className="space-y-4">
          {history?.groups.map((source) => (
            <section key={source.sourceId} className="rounded border border-[color:var(--color-border-subtle)] p-3">
              <header className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold">{source.label || source.agentType}</h2>
                <span className="text-xs text-[color:var(--color-fg-tertiary)]">{source.agentType} · {source.state}</span>
              </header>
              <div className="space-y-3">
                {source.workspaces.map((workspace) => (
                  <section key={workspace.cwd} className="rounded bg-[color:var(--color-bg-secondary)] p-3">
                    <h3 className="mb-2 text-xs text-[color:var(--color-fg-tertiary)]">{workspace.cwd}</h3>
                    <div className="space-y-2">
                      {workspace.sessions.map((session) => (
                        <Link
                          key={session.sessionKey}
                          href={`/history/detail?sourceId=${encodeURIComponent(source.sourceId)}&sessionKey=${encodeURIComponent(session.sessionKey)}`}
                          className="block rounded border border-[color:var(--color-border-subtle)] p-3 hover:border-[color:var(--color-border-strong)]"
                        >
                          <div className="mb-1 flex items-center justify-between gap-3 text-xs text-[color:var(--color-fg-tertiary)]">
                            <span>{session.nativeSessionId || session.sessionKey}</span>
                            <span>{formatTime(session.endedAt || session.startedAt)}</span>
                          </div>
                          <p className="text-sm font-medium">{session.title || '未命名会话'}</p>
                          <p className="line-clamp-2 whitespace-pre-wrap text-xs text-[color:var(--color-fg-secondary)]">
                            {session.snippet || `${session.messageCount} 条消息`}
                          </p>
                        </Link>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            </section>
          ))}
          {!error && history && history.groups.length === 0 && (
            <p className="py-12 text-center text-sm text-[color:var(--color-fg-quaternary)]">暂无对话记录</p>
          )}
        </div>
      </div>
    </main>
  );
}
