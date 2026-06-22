'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { searchRecords } from '../lib/api';
import type { ConversationSearchItem } from '../lib/types';

function formatTime(value: string | null): string {
  if (!value) return '时间未知';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export default function HistoryPage() {
  const [items, setItems] = useState<ConversationSearchItem[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((value: string) => {
    setError(null);
    searchRecords({ query: value.trim() || '*', limit: 50 })
      .then((result) => setItems(result.items))
      .catch((err) => setError(err instanceof Error ? err.message : '加载历史失败'));
  }, []);

  useEffect(() => {
    // 初次加载放在异步回调中，避免 effect 内同步级联更新。
    searchRecords({ query: '*', limit: 50 })
      .then((result) => setItems(result.items))
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
            placeholder="搜索对话内容"
            className="flex-1 rounded border border-[color:var(--color-border-strong)] bg-transparent px-3 py-2 text-sm outline-none"
          />
          <button type="submit" className="rounded bg-[color:var(--color-accent-primary)] px-4 py-2 text-sm text-white">
            搜索
          </button>
        </form>

        {error && <p className="mb-4 text-sm text-[color:var(--color-accent-danger)]">{error}</p>}
        <div className="space-y-2">
          {items.map(({ conversation, snippet }) => (
            <Link
              key={conversation.id}
              href={`/history/detail?recordId=${encodeURIComponent(conversation.id)}`}
              className="block rounded border border-[color:var(--color-border-subtle)] p-3 hover:border-[color:var(--color-border-strong)]"
            >
              <div className="mb-1 flex items-center justify-between gap-3 text-xs text-[color:var(--color-fg-tertiary)]">
                <span>{conversation.role}</span>
                <span>{formatTime(conversation.endedAt || conversation.createdAt)}</span>
              </div>
              <p className="line-clamp-3 whitespace-pre-wrap text-sm">
                {snippet || conversation.content || '（空内容）'}
              </p>
            </Link>
          ))}
          {!error && items.length === 0 && (
            <p className="py-12 text-center text-sm text-[color:var(--color-fg-quaternary)]">暂无对话记录</p>
          )}
        </div>
      </div>
    </main>
  );
}
