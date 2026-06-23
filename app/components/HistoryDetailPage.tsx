'use client';

/**
 * 单个历史会话的详情页。
 * 通过 sourceId + sessionKey 拉取消息列表与会话元数据；会话不存在会展示 "会话不存在" 而非崩溃。
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ApiError, getHistorySession } from '../lib/api';
import type { HistorySessionDetailResponse } from '../lib/types';

export default function HistoryDetailPage({ sourceId, sessionKey }: { sourceId: string; sessionKey: string }) {
  const [detail, setDetail] = useState<HistorySessionDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getHistorySession({ sourceId, sessionKey })
      .then((result) => setDetail(result))
      .catch((err) => {
        const missing = err instanceof ApiError && err.code === 'history_session_not_found';
        setError(missing ? '会话不存在' : err instanceof Error ? err.message : '加载失败');
      });
  }, [sourceId, sessionKey]);

  return (
    <main className="min-h-screen bg-[color:var(--color-bg-primary)] text-[color:var(--color-fg-primary)]">
      <header className="h-12 border-b border-[color:var(--color-border-subtle)] px-5 flex items-center gap-4">
        <Link href="/history" className="text-sm hover:text-[color:var(--color-accent)]">← 返回历史</Link>
        {detail && <span className="text-xs text-[color:var(--color-fg-tertiary)]">{detail.source.label || detail.source.agentType}</span>}
      </header>
      <article className="max-w-4xl mx-auto p-5">
        {error && <p className="text-sm text-[color:var(--color-accent-danger)]">{error}</p>}
        {!detail && !error && <p className="text-sm text-[color:var(--color-fg-tertiary)]">加载中…</p>}
        {detail && (
          <>
            <h1 className="mb-4 text-lg font-semibold">{detail.session.title || '未命名会话'}</h1>
            <dl className="mb-5 grid grid-cols-[100px_1fr] gap-2 text-xs">
              <dt className="text-[color:var(--color-fg-tertiary)]">会话</dt><dd>{detail.session.nativeSessionId || detail.session.sessionKey}</dd>
              <dt className="text-[color:var(--color-fg-tertiary)]">目录</dt><dd>{detail.session.cwd || '—'}</dd>
              <dt className="text-[color:var(--color-fg-tertiary)]">来源</dt><dd>{detail.source.label || detail.source.agentType}</dd>
              <dt className="text-[color:var(--color-fg-tertiary)]">时间</dt><dd>{detail.session.endedAt || detail.session.startedAt || '—'}</dd>
            </dl>
            <div className="space-y-3">
              {detail.messages.map((message) => (
                <section key={message.id} className="rounded border border-[color:var(--color-border-subtle)] p-4">
                  <div className="mb-2 flex items-center justify-between text-xs text-[color:var(--color-fg-tertiary)]">
                    <span>#{message.messageIndex} · {message.role}</span>
                    <span>{message.endedAt || message.createdAt}</span>
                  </div>
                  <pre className="whitespace-pre-wrap text-sm">{message.content || '（空内容）'}</pre>
                  {(message.toolCalls || message.toolCallId || message.metadata) && (
                    <dl className="mt-3 grid grid-cols-[90px_1fr] gap-2 text-xs">
                      {message.toolCallId && <><dt className="text-[color:var(--color-fg-tertiary)]">工具 ID</dt><dd>{message.toolCallId}</dd></>}
                      {message.toolCalls && <><dt className="text-[color:var(--color-fg-tertiary)]">工具调用</dt><dd className="break-all">{message.toolCalls}</dd></>}
                      {message.metadata && <><dt className="text-[color:var(--color-fg-tertiary)]">元数据</dt><dd className="break-all">{message.metadata}</dd></>}
                    </dl>
                  )}
                </section>
              ))}
            </div>
          </>
        )}
      </article>
    </main>
  );
}
