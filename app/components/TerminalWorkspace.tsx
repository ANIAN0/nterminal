'use client';

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useRouter } from 'next/navigation';
import { Terminal } from '@wterm/react';
import { searchRecords } from '../lib/api';
import type { RecordSearchItem } from '../lib/types';

// 状态机：设计 4.6 终端页 11 态
type WsStatus = 'connecting' | 'running' | 'exited' | 'error';
type MatchStatus = 'idle' | 'match_pending' | 'match_results' | 'match_empty' | 'match_error' | 'cancelled';

const SEARCH_DEBOUNCE_MS = 150;

function isPrintable(ch: string): boolean {
  return ch >= ' ' && ch !== '\x1b' && ch !== '\x7f';
}

export default function TerminalWorkspace({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const terminalRef = useRef<{ write?: (data: string) => void } | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [inputBuffer, setInputBuffer] = useState('');
  const deferredBuffer = useDeferredValue(inputBuffer);

  const [wsStatus, setWsStatus] = useState<WsStatus>('connecting');
  const [error, setError] = useState<string | null>(null);

  const [searchResults, setSearchResults] = useState<RecordSearchItem[]>([]);
  const [matchStatus, setMatchStatus] = useState<MatchStatus>('idle');

  // ---- WS 连接 ----
  useEffect(() => {
    if (!sessionId) return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/ws/pty/${sessionId}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;
    setWsStatus('connecting');

    ws.onopen = () => {
      setWsStatus('running');
      setError(null);
    };
    ws.onclose = () => {
      setWsStatus('exited');
      setError(null);
    };
    ws.onerror = () => {
      setWsStatus('error');
      setError('WS 连接错误');
    };
    ws.onmessage = async (ev) => {
      const data = ev.data;
      if (typeof data === 'string') {
        terminalRef.current?.write?.(data);
        return;
      }
      let text: string;
      if (data instanceof ArrayBuffer) {
        text = new TextDecoder().decode(data);
      } else if (data instanceof Blob) {
        text = await data.text();
      } else {
        text = String(data ?? '');
      }
      terminalRef.current?.write?.(text);
    };

    return () => {
      ws.close();
    };
  }, [sessionId]);

  // ---- 搜索：inputBuffer 变化触发 debounced search ----
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (abortRef.current) abortRef.current.abort();

    if (deferredBuffer.length < 1) {
      setSearchResults([]);
      setMatchStatus('idle');
      return;
    }

    setMatchStatus('match_pending');
    debounceRef.current = setTimeout(async () => {
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const r = await searchRecords(
          { query: deferredBuffer, limit: 10, scope: 'global' },
          { signal: controller.signal },
        );
        if (controller.signal.aborted) {
          setMatchStatus('cancelled');
          return;
        }
        if (r.items.length === 0) {
          setSearchResults([]);
          setMatchStatus('match_empty');
        } else {
          setSearchResults(r.items);
          setMatchStatus('match_results');
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          setMatchStatus('cancelled');
          return;
        }
        setMatchStatus('match_error');
        console.error('search failed', err);
      }
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [deferredBuffer]);

  // ---- 字符 → PTY ----
  const handleTerminalData = useCallback((data: string) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(data);
    }
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') {
        setInputBuffer('');
        continue;
      }
      if (ch === '\b' || ch === '\x7f') {
        setInputBuffer((prev) => prev.slice(0, -1));
        continue;
      }
      if (isPrintable(ch)) {
        setInputBuffer((prev) => prev + ch);
      }
    }
  }, []);

  const handleTerminalResize = useCallback((cols: number, rows: number) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ _ctrl: { type: 'resize', cols, rows } }));
    }
  }, []);

  const inputStatus: 'input_idle' | 'editing' = inputBuffer.length > 0 ? 'editing' : 'input_idle';

  const wsStatusText = useMemo(() => {
    switch (wsStatus) {
      case 'connecting': return '连接中';
      case 'running': return '运行中';
      case 'exited': return '已退出';
      case 'error': return '错误';
    }
  }, [wsStatus]);

  const wsPillClass = useMemo(() => {
    switch (wsStatus) {
      case 'connecting': return 'pill connecting';
      case 'running': return 'pill running';
      case 'exited': return 'pill idle';
      case 'error': return 'pill error';
    }
  }, [wsStatus]);

  const matchStatusText = useMemo(() => {
    switch (matchStatus) {
      case 'idle': return '';
      case 'match_pending': return '搜索中…';
      case 'match_results': return `${searchResults.length} 条匹配`;
      case 'match_empty': return '无匹配记录';
      case 'match_error': return '搜索失败';
      case 'cancelled': return '';
    }
  }, [matchStatus, searchResults.length]);

  function handleResultClick(item: RecordSearchItem) {
    router.push(`/history/detail?recordId=${encodeURIComponent(item.recordId)}`);
  }

  if (!sessionId) {
    return (
      <div className="min-h-screen flex items-center justify-center text-[color:var(--color-accent-danger)]" data-testid="no-session">
        缺少 sessionId 参数
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {/* 顶部 chrome —— 深色磨砂 + 状态 pill */}
      <header
        className="flex items-center justify-between px-4 py-2 border-b border-[color:var(--color-border-subtle)] bg-[color:var(--color-bg-panel-strong)] backdrop-blur-md"
        style={{ WebkitBackdropFilter: 'blur(10px)' }}
      >
        <div className="flex items-center gap-3">
          <a href="/" className="flex items-center gap-2 text-sm hover:opacity-80 transition-opacity" aria-label="返回首页">
            <TerminalLogo />
            <span className="font-semibold tracking-tight">nterminal</span>
          </a>
          <span className="text-[color:var(--color-fg-quaternary)] text-xs">·</span>
          <span className={wsPillClass} data-testid="status">
            <span className="dot" />
            {wsStatusText}
          </span>
          <span className="chip mono text-[10px]" title={sessionId} data-testid="session-id">
            {sessionId.slice(0, 8)}…
          </span>
        </div>

        <div className="flex items-center gap-3 text-sm">
          <div className="flex items-center gap-2 text-[color:var(--color-fg-tertiary)]">
            <span className="text-[11px] uppercase tracking-[0.1em]">input</span>
            <code
              className="mono px-2 py-0.5 rounded-md bg-[rgba(255,255,255,0.04)] border border-[color:var(--color-border-subtle)] text-[color:var(--color-fg-primary)] text-[12px] min-w-[80px] inline-block truncate max-w-[260px]"
              data-testid="input-buffer"
            >
              {inputBuffer || <span className="text-[color:var(--color-fg-quaternary)]">(空)</span>}
            </code>
            <span className="chip text-[10px]" data-testid="input-status">
              {inputStatus === 'editing' ? '编辑中' : '空闲'}
            </span>
          </div>
        </div>
      </header>

      {error && (
        <div
          role="alert"
          className="flex items-center gap-2 bg-[rgba(255,130,114,0.08)] border-b border-[rgba(255,130,114,0.3)] text-[color:var(--color-accent-danger)] px-4 py-1.5 text-[12px]"
          data-testid="error-banner"
        >
          <span>⚠</span>
          <span>{error}</span>
        </div>
      )}

      {/* 终端主体 —— 居中卡片 */}
      <div className="flex-1 relative p-3 sm:p-5 flex items-stretch justify-center min-h-0">
        <div className="poc-terminal w-full max-w-[1100px]">
          <Terminal
            ref={terminalRef}
            onData={handleTerminalData}
            onResize={handleTerminalResize}
            className="h-full"
          />
        </div>

        {/* 命令面板式搜索浮层（参考 warp command_palette / wterm 风格） */}
        {matchStatus !== 'idle' && (
          <aside
            className="absolute top-7 right-5 sm:right-7 w-[340px] max-h-[60vh] flex flex-col overflow-hidden rounded-xl border border-[color:var(--color-border-strong)] shadow-2xl"
            style={{
              background: 'var(--color-bg-panel-strong)',
              backdropFilter: 'blur(14px)',
              WebkitBackdropFilter: 'blur(14px)',
              boxShadow: 'var(--shadow-card)',
            }}
            data-testid="search-results"
            data-status={matchStatus}
          >
            <div className="px-3 py-2.5 border-b border-[color:var(--color-border-subtle)] flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <SearchIcon />
                <span className="text-[12px] font-medium text-[color:var(--color-fg-secondary)] truncate">
                  {matchStatusText}
                </span>
              </div>
              <span className="chip text-[10px] shrink-0">全局</span>
            </div>

            <div className="overflow-y-auto flex-1">
              {matchStatus === 'match_pending' && (
                <div className="px-3 py-6 text-center text-xs text-[color:var(--color-fg-tertiary)]" data-testid="match-pending">
                  <Spinner /> 正在搜索…
                </div>
              )}
              {matchStatus === 'match_empty' && (
                <div className="px-3 py-8 text-center" data-testid="match-empty">
                  <div className="text-[color:var(--color-fg-quaternary)] text-2xl mb-1">∅</div>
                  <div className="text-xs text-[color:var(--color-fg-tertiary)]">无匹配记录</div>
                </div>
              )}
              {matchStatus === 'match_error' && (
                <div className="px-3 py-3 text-xs text-[color:var(--color-accent-danger)]" data-testid="match-error">
                  搜索失败，请重试
                </div>
              )}
              {matchStatus === 'match_results' && (
                <ul className="py-1">
                  {searchResults.map((item) => (
                    <li
                      key={item.recordId}
                      className="group cursor-pointer px-3 py-2 hover:bg-[rgba(165,213,254,0.07)] border-l-2 border-transparent hover:border-[color:var(--color-accent)] transition-colors"
                      onClick={() => handleResultClick(item)}
                      data-testid="search-item"
                    >
                      <div className="flex items-center gap-1.5 text-[10px] text-[color:var(--color-fg-tertiary)] mono mb-0.5">
                        <ChevronIcon />
                        <span className="truncate" title={item.cwd}>{item.displayName || item.cwd}</span>
                      </div>
                      <div className="text-[12.5px] text-[color:var(--color-fg-primary)] truncate">
                        {item.userTextPreview || <span className="text-[color:var(--color-fg-quaternary)]">(空)</span>}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="chip text-[9px] mono">{item.endState}</span>
                        <span className="text-[10px] text-[color:var(--color-fg-quaternary)]">
                          {new Date(item.startedAt).toLocaleTimeString()}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="px-3 py-1.5 border-t border-[color:var(--color-border-subtle)] text-[10px] text-[color:var(--color-fg-quaternary)] flex items-center justify-between">
              <span>↑↓ 选择 · ↵ 跳转</span>
              <span className="mono">esc 关闭</span>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

/* ---- 轻量内联图标 ---- */
function TerminalLogo() {
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
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="11" cy="11" r="6" stroke="currentColor" strokeWidth="1.6" />
      <line x1="16" y1="16" x2="20" y2="20" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M9 6 L15 12 L9 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg className="inline-block align-[-2px] mr-1 animate-spin" width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.2" />
      <path d="M21 12 a9 9 0 0 0 -9 -9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}