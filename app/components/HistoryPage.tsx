'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { listRecords } from '../lib/api';
import type { HistoryGroup, HistoryGroupSession, RecordSummary } from '../lib/types';

const SEARCH_DEBOUNCE_MS = 200;

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(iso).toLocaleDateString();
}

function endStateColor(state: string): string {
  switch (state) {
    case 'recording':
      return 'var(--color-status-running)';
    case 'idle':
      return 'var(--color-fg-tertiary)';
    case 'session_exit':
      return 'var(--color-accent)';
    case 'error':
      return 'var(--color-status-error)';
    default:
      return 'var(--color-fg-tertiary)';
  }
}

export default function HistoryPage() {
  const router = useRouter();
  const [groups, setGroups] = useState<HistoryGroup[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const load = useCallback(async (q: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const r = await listRecords({ query: q, limit: 50 });
      setGroups(r.groups || []);
      setTotal(r.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载历史失败');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => load(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query, load]);

  function handleItemClick(recordId: string) {
    router.push(`/history/detail?recordId=${encodeURIComponent(recordId)}`);
  }

  return (
    <div className="min-h-screen w-full flex flex-col">
      <header className="w-full px-6 py-4 flex items-center justify-between border-b border-[color:var(--color-border-subtle)]">
        <div className="flex items-center gap-2.5">
          <a href="/" className="flex items-center gap-2 text-sm hover:opacity-80 transition-opacity">
            <Logo />
            <span className="font-semibold tracking-tight">nterminal</span>
          </a>
          <span className="text-[color:var(--color-fg-quaternary)] text-xs">·</span>
          <h1 className="text-sm text-[color:var(--color-fg-secondary)]">历史记录</h1>
        </div>
        <a href="/" className="nav-link" data-testid="back-home">
          ← 返回首页
        </a>
      </header>

      <main className="flex-1 w-full max-w-4xl mx-auto px-6 py-8 flex flex-col gap-6">
        <section className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-2xl font-semibold tracking-tight">会话历史</h2>
            <span className="chip mono">共 {total} 条</span>
          </div>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[color:var(--color-fg-tertiary)]">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <circle cx="11" cy="11" r="6" stroke="currentColor" strokeWidth="1.6" />
                <line x1="16" y1="16" x2="20" y2="20" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </span>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索 user text..."
              className="input-mono pl-9"
              data-testid="search-input"
              autoFocus
            />
          </div>
        </section>

        {error && (
          <div
            role="alert"
            className="flex items-center gap-2 text-[13px] text-[color:var(--color-accent-danger)] bg-[rgba(255,130,114,0.06)] border border-[rgba(255,130,114,0.25)] rounded-lg px-3 py-2"
            data-testid="error-banner"
          >
            <span>{error}</span>
            <button
              type="button"
              onClick={() => load(query)}
              className="ml-auto underline text-xs"
              data-testid="retry"
            >
              重试
            </button>
          </div>
        )}

        {isLoading && (
          <div className="glass-panel px-4 py-3 text-center text-xs text-[color:var(--color-fg-tertiary)]" data-testid="loading">
            加载中…
          </div>
        )}

        {!isLoading && groups.length === 0 && !error && (
          <div className="glass-panel px-4 py-12 text-center" data-testid="empty-state">
            <div className="text-3xl mb-2 opacity-60">📜</div>
            <div className="text-sm text-[color:var(--color-fg-secondary)]">
              {query ? '无匹配记录' : '暂无历史'}
            </div>
            <div className="text-xs text-[color:var(--color-fg-tertiary)] mt-1">
              {query ? '换个关键词试试' : '启动一次终端会话后会出现在这里'}
            </div>
          </div>
        )}

        <div className="flex flex-col gap-3" data-testid="groups">
          {groups.map((g) => (
            <section
              key={g.cwd}
              className="glass-panel overflow-hidden"
              data-testid="cwd-group"
            >
              <header className="px-3 py-2.5 border-b border-[color:var(--color-border-subtle)] flex items-center gap-2.5 bg-[rgba(255,255,255,0.02)]">
                <FolderIcon />
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium truncate">{g.displayName}</div>
                  <div className="text-[11px] text-[color:var(--color-fg-tertiary)] mono truncate" title={g.cwd}>
                    {g.cwd}
                  </div>
                </div>
                <span className="chip text-[10px]">
                  {g.sessions.length} session · {g.sessions.reduce((acc: number, s: HistoryGroupSession) => acc + s.records.length, 0)} cmd
                </span>
              </header>

              <div>
                {g.sessions.map((s: HistoryGroupSession) => (
                  <div
                    key={s.sessionId}
                    className="border-b border-[color:var(--color-border-subtle)] last:border-b-0"
                    data-testid="session-group"
                  >
                    <div className="px-3 py-1.5 flex items-center gap-2 text-[11px] text-[color:var(--color-fg-tertiary)] bg-[rgba(0,0,0,0.18)]">
                      <span className="mono">{s.sessionId.slice(0, 8)}…</span>
                      <span>·</span>
                      <span className="mono truncate">{s.command || '(default shell)'}</span>
                    </div>
                    <ul>
                      {s.records.map((r: RecordSummary) => (
                        <li
                          key={r.recordId}
                          className="group cursor-pointer px-3 py-2.5 hover:bg-[rgba(165,213,254,0.05)] border-l-2 border-transparent hover:border-[color:var(--color-accent)] transition-colors"
                          onClick={() => handleItemClick(r.recordId)}
                          data-testid="record-item"
                        >
                          <div className="text-[13px] whitespace-pre-wrap break-words text-[color:var(--color-fg-primary)]">
                            {r.userTextPreview || <span className="text-[color:var(--color-fg-quaternary)]">(空)</span>}
                          </div>
                          <div className="flex items-center gap-2 mt-1.5">
                            <span
                              className="chip text-[9px] mono"
                              style={{ color: endStateColor(r.endState), borderColor: 'var(--color-border-subtle)' }}
                            >
                              {r.endState}
                            </span>
                            <span className="text-[10px] text-[color:var(--color-fg-quaternary)]">
                              {relativeTime(r.startedAt)}
                            </span>
                            <ChevronIcon className="ml-auto opacity-0 group-hover:opacity-100 transition-opacity text-[color:var(--color-accent)]" />
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
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

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="text-[color:var(--color-accent)] shrink-0">
      <path
        d="M3 6.5 A1.5 1.5 0 0 1 4.5 5 H9 L11 7 H19.5 A1.5 1.5 0 0 1 21 8.5 V17 A1.5 1.5 0 0 1 19.5 18.5 H4.5 A1.5 1.5 0 0 1 3 17 Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path d="M9 6 L15 12 L9 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}