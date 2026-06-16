'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, getRecordDetail } from '../lib/api';
import type { InteractionRecord } from '../lib/types';
import { stripAnsi } from '../lib/text';

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(iso).toLocaleString();
}

function endStateColor(state: string): string {
  switch (state) {
    case 'recording': return 'var(--color-status-running)';
    case 'idle': return 'var(--color-fg-tertiary)';
    case 'session_exit': return 'var(--color-accent)';
    case 'error': return 'var(--color-status-error)';
    default: return 'var(--color-fg-tertiary)';
  }
}

export default function HistoryDetailPage({ recordId }: { recordId: string }) {
  const router = useRouter();
  const [record, setRecord] = useState<InteractionRecord | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!recordId) return;
    setIsLoading(true);
    setError(null);
    setNotFound(false);
    getRecordDetail({ recordId })
      .then((r) => {
        if (r && r.record) {
          setRecord(r.record);
        } else {
          setNotFound(true);
        }
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : '加载失败';
        if (err instanceof ApiError && err.code === 'record_not_found') {
          setNotFound(true);
        } else if (err instanceof ApiError && err.code === 'not_found') {
          setNotFound(true);
        } else {
          setError(msg);
        }
      })
      .finally(() => setIsLoading(false));
  }, [recordId]);

  if (isLoading) {
    return (
      <div className="min-h-screen w-full flex flex-col">
        <TopBar onBack={() => router.push('/history')} />
        <main className="flex-1 max-w-4xl w-full mx-auto px-6 py-12">
          <div className="glass-panel px-4 py-12 text-center text-sm text-[color:var(--color-fg-tertiary)]" data-testid="loading">
            加载中…
          </div>
        </main>
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="min-h-screen w-full flex flex-col">
        <TopBar onBack={() => router.push('/history')} />
        <main className="flex-1 max-w-4xl w-full mx-auto px-6 py-12 flex flex-col gap-4" data-testid="not-found">
          <div className="glass-panel px-6 py-10 text-center">
            <div className="text-3xl mb-3 opacity-60">🔍</div>
            <h1 className="text-xl font-semibold mb-1">记录不存在</h1>
            <p className="text-sm text-[color:var(--color-fg-tertiary)] mb-4">
              该 recordId 可能已被清理或链接失效
            </p>
            <button onClick={() => router.push('/history')} className="btn-ghost" data-testid="back-link">
              ← 返回历史
            </button>
          </div>
        </main>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen w-full flex flex-col">
        <TopBar onBack={() => router.push('/history')} />
        <main className="flex-1 max-w-4xl w-full mx-auto px-6 py-12 flex flex-col gap-4" data-testid="error">
          <div role="alert" className="flex items-center gap-2 text-[13px] text-[color:var(--color-accent-danger)] bg-[rgba(255,130,114,0.06)] border border-[rgba(255,130,114,0.25)] rounded-lg px-3 py-2">
            <span>{error}</span>
          </div>
          <button onClick={() => router.push('/history')} className="btn-ghost self-start" data-testid="back-link">
            ← 返回历史
          </button>
        </main>
      </div>
    );
  }

  if (!record) return null;

  return (
    <div className="min-h-screen w-full flex flex-col">
      <TopBar onBack={() => router.push('/history')} />

      <main className="flex-1 max-w-4xl w-full mx-auto px-6 py-8 flex flex-col gap-6">
        <section className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="chip mono text-[10px]" style={{ color: endStateColor(record.endState) }}>
              {record.endState}
            </span>
            <span className="chip mono text-[10px]" title={record.recordId || record.id}>
              {(record.recordId || record.id || '').slice(0, 8)}…
            </span>
            <span className="text-[11px] text-[color:var(--color-fg-tertiary)] ml-auto">
              {relativeTime(record.startedAt)}
            </span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">记录详情</h1>
        </section>

        {/* metadata chips 网格 */}
        <section className="grid grid-cols-1 sm:grid-cols-2 gap-2.5" data-testid="metadata">
          <MetaCell label="cwd" value={record.cwd} mono />
          <MetaCell label="session" value={record.sessionId} mono />
          <MetaCell label="startedAt" value={record.startedAt} />
          <MetaCell label="endedAt" value={record.endedAt || '(未结束)'} />
          <MetaCell label="endState" value={record.endState} />
          <MetaCell label="error" value={record.error || '(无)'} />
        </section>

        {/* userText */}
        <section className="flex flex-col gap-2">
          <SectionHeader label="userText" accent="var(--color-accent-2)" />
          <pre
            className="glass-panel px-3 py-3 text-[13px] whitespace-pre-wrap break-words mono text-[color:var(--color-fg-primary)] overflow-x-auto"
            data-testid="user-text"
          >
            {record.userText || <span className="text-[color:var(--color-fg-quaternary)]">(空)</span>}
          </pre>
        </section>

        {/* outputText */}
        <section className="flex flex-col gap-2">
          <SectionHeader label="outputText" accent="var(--color-accent)" />
          <pre
            className="glass-panel px-3 py-3 text-[13px] whitespace-pre-wrap break-words mono text-[color:var(--color-fg-primary)] overflow-x-auto max-h-[60vh]"
            data-testid="output-text"
          >
            {stripAnsi(record.outputText) || <span className="text-[color:var(--color-fg-quaternary)]">(空)</span>}
          </pre>
        </section>
      </main>
    </div>
  );
}

function TopBar({ onBack }: { onBack: () => void }) {
  return (
    <header className="w-full px-6 py-4 flex items-center justify-between border-b border-[color:var(--color-border-subtle)]">
      <div className="flex items-center gap-2.5">
        <a href="/" className="flex items-center gap-2 text-sm hover:opacity-80 transition-opacity">
          <Logo />
          <span className="font-semibold tracking-tight">nterminal</span>
        </a>
        <span className="text-[color:var(--color-fg-quaternary)] text-xs">·</span>
        <h1 className="text-sm text-[color:var(--color-fg-secondary)]">历史详情</h1>
      </div>
      <button onClick={onBack} className="nav-link">← 返回历史</button>
    </header>
  );
}

function MetaCell({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="glass-panel px-3 py-2 flex flex-col gap-0.5 min-w-0">
      <span className="text-[10px] uppercase tracking-[0.1em] text-[color:var(--color-fg-tertiary)]">{label}</span>
      <span
        className={'text-[12.5px] text-[color:var(--color-fg-primary)] truncate ' + (mono ? 'mono' : '')}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function SectionHeader({ label, accent }: { label: string; accent: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="inline-block h-3 w-0.5 rounded-sm" style={{ background: accent }} />
      <h2 className="text-[11px] uppercase tracking-[0.12em] text-[color:var(--color-fg-tertiary)]">{label}</h2>
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