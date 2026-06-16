'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  ApiError,
  validateDirectory,
  createSession,
  listPathHistory,
  deletePathHistory,
  clearPathHistory,
} from '../lib/api';
import type { PathHistoryItem } from '../lib/types';

type PageStatus = 'idle' | 'input' | 'history_empty' | 'selected' | 'creating' | 'error' | 'no_permission';

// 用相对时间显示，避免满屏 "2026/6/17" 干扰阅读
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

export default function PathEntryPage() {
  const router = useRouter();
  const [inputValue, setInputValue] = useState('');
  const [pathHistory, setPathHistory] = useState<PathHistoryItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const r = await listPathHistory({ limit: 50 });
      setPathHistory(r.items || []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载历史失败');
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const path = (selectedPath || inputValue).trim();
    if (!path) {
      setError('请输入路径');
      return;
    }
    setIsValidating(true);
    try {
      await validateDirectory({ path });
    } catch (err) {
      setIsValidating(false);
      if (err instanceof ApiError && err.code === 'no_permission') {
        setError('当前用户无权限访问该目录');
        return;
      }
      setError(err instanceof ApiError ? err.message : '路径校验失败');
      return;
    }
    setIsValidating(false);
    setIsLoading(true);
    try {
      const session = await createSession({ cwd: path });
      // 异步保存历史（不阻塞跳转）
      savePathHistory({ path }).catch(() => {});
      router.push(`/terminal?sessionId=${encodeURIComponent(session.id)}`);
    } catch (err) {
      setIsLoading(false);
      if (err instanceof ApiError && err.code === 'no_permission') {
        setError('当前用户无权限创建会话');
      } else {
        setError(err instanceof ApiError ? err.message : '创建会话失败');
      }
    }
  }

  async function savePathHistory(body: { path: string }) {
    const { savePathHistory: save } = await import('../lib/api');
    await save(body);
  }

  function handleSelectItem(item: PathHistoryItem) {
    setInputValue(item.path);
    setSelectedPath(item.path);
    setError(null);
  }

  async function handleDeleteItem(item: PathHistoryItem, e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await deletePathHistory({ path: item.path });
      if (selectedPath === item.path) setSelectedPath(null);
      await loadHistory();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '删除失败');
    }
  }

  async function handleClearAll() {
    try {
      await clearPathHistory();
      setPathHistory([]);
      setSelectedPath(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '清空失败');
    }
  }

  // 计算当前 page status（按设计 4.6 入口页 7 态）
  const pageStatus: PageStatus = useMemo(() => {
    if (error && (error.includes('无权限') || error.includes('no_permission'))) return 'no_permission';
    if (isValidating || isLoading) return 'creating';
    if (error) return 'error';
    if (selectedPath) return 'selected';
    if (inputValue.trim().length > 0) return 'input';
    if (pathHistory.length === 0 && !historyLoading) return 'history_empty';
    return 'idle';
  }, [error, isValidating, isLoading, selectedPath, inputValue, pathHistory.length, historyLoading]);

  const submitting = isValidating || isLoading;
  const submitLabel = isValidating ? '校验中…' : isLoading ? '创建中…' : '打开终端 →';

  return (
    <div className="min-h-screen w-full flex flex-col">
      {/* 顶部细条 —— 品牌 + 跳转 */}
      <header className="w-full px-6 py-4 flex items-center justify-between border-b border-[color:var(--color-border-subtle)]">
        <div className="flex items-center gap-2.5">
          <Logo />
          <span className="text-[15px] font-semibold tracking-tight">nterminal</span>
          <span className="chip ml-1 mono">v0.1</span>
        </div>
        <nav className="flex items-center gap-1">
          <a className="nav-link" href="/history">历史记录</a>
        </nav>
      </header>

      {/* 主区 —— hero + 输入 + 历史 */}
      <main className="flex-1 w-full flex flex-col items-center px-6 py-12 gap-10">
        <section className="w-full max-w-2xl text-center flex flex-col items-center gap-4">
          <span className="chip">
            <span className="dot inline-block h-1.5 w-1.5 rounded-full bg-[color:var(--color-accent-2)]" />
            工作目录已就绪
          </span>
          <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-[color:var(--color-fg-primary)]">
            从一个目录开始
          </h1>
          <p className="text-sm text-[color:var(--color-fg-secondary)] max-w-md">
            选择或输入一个工作目录，我们会为你启动一个专属的 PTY 终端会话。
            所有交互会自动存档，可在「历史记录」中检索与回放。
          </p>
        </section>

        <form
          onSubmit={handleSubmit}
          className="w-full max-w-2xl flex flex-col gap-3"
          data-testid="path-form"
        >
          <label className="text-[11px] uppercase tracking-[0.12em] text-[color:var(--color-fg-tertiary)]">
            工作目录
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={inputValue}
              onChange={(e) => {
                setInputValue(e.target.value);
                if (selectedPath) setSelectedPath(null);
              }}
              placeholder="C:\workspace\my-project  或  /home/me/proj"
              className="input-mono flex-1"
              data-testid="path-input"
              disabled={submitting}
              autoFocus
              spellCheck={false}
            />
            <button
              type="submit"
              disabled={submitting}
              className="btn-primary"
              data-testid="path-submit"
            >
              {submitLabel}
            </button>
          </div>

          {error && (
            <div
              role="alert"
              className={
                pageStatus === 'no_permission'
                  ? 'flex items-start gap-2 text-[13px] text-[color:var(--color-accent-warn)] bg-[rgba(254,253,194,0.06)] border border-[rgba(254,253,194,0.25)] rounded-lg px-3 py-2'
                  : 'flex items-start gap-2 text-[13px] text-[color:var(--color-accent-danger)] bg-[rgba(255,130,114,0.06)] border border-[rgba(255,130,114,0.25)] rounded-lg px-3 py-2'
              }
              data-testid="error-banner"
              data-page-status={pageStatus}
            >
              <span className="mono">{pageStatus === 'no_permission' ? '⛔' : '⚠'}</span>
              <span>{error}</span>
            </div>
          )}
        </form>

        <section className="w-full max-w-2xl" data-testid="history-section">
          <div className="flex items-center justify-between mb-3 px-1">
            <div className="flex items-center gap-2">
              <h2 className="text-[11px] uppercase tracking-[0.12em] text-[color:var(--color-fg-tertiary)]">
                最近使用
              </h2>
              <span className="chip">{pathHistory.length}</span>
            </div>
            {pathHistory.length > 0 && (
              <button
                type="button"
                onClick={handleClearAll}
                className="text-xs text-[color:var(--color-fg-tertiary)] hover:text-[color:var(--color-accent-danger)] transition-colors"
                data-testid="clear-all"
              >
                清空全部
              </button>
            )}
          </div>

          {historyLoading && (
            <div className="glass-panel px-4 py-6 text-center text-xs text-[color:var(--color-fg-tertiary)]" data-testid="history-loading">
              加载中…
            </div>
          )}

          {!historyLoading && pathHistory.length === 0 && (
            <div className="glass-panel px-4 py-8 text-center" data-testid="empty-history">
              <div className="text-2xl mb-2 opacity-60">📁</div>
              <div className="text-sm text-[color:var(--color-fg-secondary)]">暂无历史</div>
              <div className="text-xs text-[color:var(--color-fg-tertiary)] mt-1">
                输入或选择一个目录后会出现在这里
              </div>
            </div>
          )}

          <ul className="flex flex-col gap-1.5" data-testid="history-list">
            {pathHistory.map((item) => {
              const selected = selectedPath === item.path;
              return (
                <li
                  key={item.path}
                  className={
                    'group glass-panel px-3 py-2.5 cursor-pointer transition-all duration-150 ' +
                    (selected
                      ? 'ring-1 ring-[color:var(--color-accent)] bg-[rgba(165,213,254,0.06)]'
                      : 'hover:bg-[rgba(255,255,255,0.03)] hover:border-[color:var(--color-border-strong)]')
                  }
                  onClick={() => handleSelectItem(item)}
                  data-testid="history-item"
                  data-selected={selected ? 'true' : 'false'}
                >
                  <div className="flex items-center gap-3">
                    <FolderIcon className="shrink-0 text-[color:var(--color-fg-tertiary)] group-hover:text-[color:var(--color-accent)] transition-colors" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate text-[color:var(--color-fg-primary)]">
                          {item.displayName}
                        </span>
                        {!item.exists && (
                          <span className="chip text-[10px]" style={{ color: 'var(--color-accent-warn)', borderColor: 'rgba(254,253,194,0.3)' }}>
                            不存在
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-[color:var(--color-fg-tertiary)] mono truncate" title={item.path}>
                        {item.path}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="chip text-[10px] mono">×{item.useCount}</span>
                      <span className="text-[10px] text-[color:var(--color-fg-quaternary)]">
                        {relativeTime(item.lastUsedAt)}
                      </span>
                      <button
                        type="button"
                        onClick={(e) => handleDeleteItem(item, e)}
                        className="opacity-0 group-hover:opacity-100 text-xs text-[color:var(--color-fg-tertiary)] hover:text-[color:var(--color-accent-danger)] transition-all px-1.5 py-0.5 rounded"
                        data-testid="delete-item"
                        aria-label="删除"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      </main>

      <footer className="w-full px-6 py-3 border-t border-[color:var(--color-border-subtle)] text-[11px] text-[color:var(--color-fg-quaternary)] flex items-center justify-between">
        <span className="mono">nterminal · web terminal workspace</span>
        <span className="hidden sm:inline">Esc 关闭 · ↑↓ 选择历史</span>
      </footer>
    </div>
  );
}

/* ---- 内联图标（避免额外依赖，样式与 dark theme 一致） ---- */
function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="2" y="3" width="20" height="14" rx="2.5" stroke="var(--color-accent)" strokeWidth="1.5" />
      <path d="M6 9 L9.5 12 L6 15" stroke="var(--color-accent-2)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <line x1="11" y1="15" x2="15" y2="15" stroke="var(--color-accent-warn)" strokeWidth="1.6" strokeLinecap="round" />
      <line x1="4" y1="20" x2="20" y2="20" stroke="var(--color-fg-tertiary)" strokeWidth="1.2" strokeLinecap="round" opacity="0.5" />
    </svg>
  );
}

function FolderIcon({ className }: { className?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M3 6.5 A1.5 1.5 0 0 1 4.5 5 H9 L11 7 H19.5 A1.5 1.5 0 0 1 21 8.5 V17 A1.5 1.5 0 0 1 19.5 18.5 H4.5 A1.5 1.5 0 0 1 3 17 Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}