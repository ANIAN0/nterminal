'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { searchRecords } from '../lib/api';

const SEARCH_DEBOUNCE_MS = 200;

// FTS5 snippet 返回的 row 结构（与 server.mjs handleRecordsSearch / database.mjs searchConversations 对齐）
interface SearchHit {
  conversation: {
    id: string;
    source_id: string;
    session_id: string | null;
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string | null;
    tool_calls: string | null;
    tool_call_id: string | null;
    metadata: string | null;
    user_text: string | null;
    ended_at: string | null;
    created_at: string;
  };
  snippet: string | null;
  rank: number;
}

// 把 FTS5 snippet 里的 <mark>...</mark> 转成 JSX 高亮片段
function renderHighlight(snippet: string | null, fallback: string): React.ReactNode {
  if (!snippet) return fallback;
  const parts: React.ReactNode[] = [];
  const re = /<mark>([\s\S]*?)<\/mark>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(snippet)) !== null) {
    if (m.index > last) parts.push(snippet.slice(last, m.index));
    parts.push(
      <mark key={`hl-${key++}`} className="bg-[rgba(165,213,254,0.25)] text-[color:var(--color-fg-primary)] rounded px-0.5">
        {m[1]}
      </mark>,
    );
    last = re.lastIndex;
  }
  if (last < snippet.length) parts.push(snippet.slice(last));
  return parts;
}

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

function Logo() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="2" y="3" width="20" height="14" rx="2.5" stroke="var(--color-accent)" strokeWidth="1.5" />
      <path d="M6 9 L9.5 12 L6 15" stroke="var(--color-accent-2)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <line x1="11" y1="15" x2="15" y2="15" stroke="var(--color-accent-warn)" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="text-[color:var(--color-accent)] shrink-0">
      <circle cx="11" cy="11" r="6" stroke="currentColor" strokeWidth="1.6" />
      <line x1="16" y1="16" x2="20" y2="20" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}