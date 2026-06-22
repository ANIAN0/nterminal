'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ApiError, deleteRecord, getRecordDetail } from '../lib/api';
import type { ConversationRecord } from '../lib/types';

export default function HistoryDetailPage({ recordId }: { recordId: string }) {
  const router = useRouter();
  const [record, setRecord] = useState<ConversationRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    getRecordDetail({ recordId })
      .then((result) => setRecord(result.record))
      .catch((err) => {
        const missing = err instanceof ApiError && err.code === 'record_not_found';
        setError(missing ? '记录不存在' : err instanceof Error ? err.message : '加载失败');
      });
  }, [recordId]);

  const handleDelete = async () => {
    if (!confirm('确定删除这条记录？')) return;
    setDeleting(true);
    try {
      await deleteRecord({ recordId });
      router.push('/history');
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败');
      setDeleting(false);
    }
  };

  return (
    <main className="min-h-screen bg-[color:var(--color-bg-primary)] text-[color:var(--color-fg-primary)]">
      <header className="h-12 border-b border-[color:var(--color-border-subtle)] px-5 flex items-center gap-4">
        <Link href="/history" className="text-sm hover:text-[color:var(--color-accent)]">← 返回历史</Link>
        {record && <span className="text-xs text-[color:var(--color-fg-tertiary)]">{record.role}</span>}
      </header>
      <article className="max-w-4xl mx-auto p-5">
        {error && <p className="text-sm text-[color:var(--color-accent-danger)]">{error}</p>}
        {!record && !error && <p className="text-sm text-[color:var(--color-fg-tertiary)]">加载中…</p>}
        {record && (
          <>
            <dl className="mb-5 grid grid-cols-[100px_1fr] gap-2 text-xs">
              <dt className="text-[color:var(--color-fg-tertiary)]">会话</dt><dd>{record.sessionId || '—'}</dd>
              <dt className="text-[color:var(--color-fg-tertiary)]">目录</dt><dd>{record.cwd || '—'}</dd>
              <dt className="text-[color:var(--color-fg-tertiary)]">时间</dt><dd>{record.endedAt || record.createdAt}</dd>
            </dl>
            <pre className="overflow-auto whitespace-pre-wrap rounded border border-[color:var(--color-border-subtle)] p-4 text-sm">
              {record.content || '（空内容）'}
            </pre>
            <button
              type="button"
              disabled={deleting}
              onClick={handleDelete}
              className="mt-5 rounded border border-[color:var(--color-accent-danger)] px-3 py-1.5 text-xs text-[color:var(--color-accent-danger)] disabled:opacity-50"
            >
              {deleting ? '删除中…' : '删除记录'}
            </button>
          </>
        )}
      </article>
    </main>
  );
}
