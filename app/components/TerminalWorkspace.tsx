'use client';

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Terminal, type TerminalHandle } from '@wterm/react';
import { closeTab, createTab, deleteTab, listTabs, queryCompletion } from '../lib/api';
import type { CompletionItem, TabInfo } from '../lib/types';
import { MAX_TABS } from '../lib/types';
import TabBar from './TabBar';
import TerminalComposer from './TerminalComposer';
import { useTerminalConnection } from './TerminalConnectionProvider';
import { useTerminalInputMode } from './useTerminalInputMode';

type WsStatus = 'connecting' | 'running' | 'exited' | 'error';

const STORAGE_KEY_ACTIVE_TAB = 'nterminal_active_tab';
const COMPLETION_DEBOUNCE_MS = 150;

function deriveTabLabel(tab: { id: string; cwd?: string }): string {
  if (tab.cwd) {
    const parts = tab.cwd.split(/[\\/]/).filter(Boolean);
    const last = parts[parts.length - 1];
    if (last) return last;
  }
  return tab.id.slice(0, 8);
}

function mergeTabs(prev: TabInfo[], live: TabInfo[], seedTabId: string): TabInfo[] {
  const byId = new Map<string, TabInfo>();
  for (const tab of prev) byId.set(tab.id, tab);
  for (const tab of live) byId.set(tab.id, tab);
  if (seedTabId && !byId.has(seedTabId)) {
    byId.set(seedTabId, { id: seedTabId, label: seedTabId.slice(0, 8), status: 'connecting' });
  }
  return Array.from(byId.values());
}

export default function TerminalWorkspace({ workspaceId, tabId }: { workspaceId: string; tabId?: string }) {
  const router = useRouter();
  const terminalRef = useRef<TerminalHandle | null>(null);
  const creatingTabRef = useRef(false);
  const completionDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>(() => {
    if (typeof window === 'undefined') return tabId || '';
    try {
      return tabId || sessionStorage.getItem(STORAGE_KEY_ACTIVE_TAB) || '';
    } catch {
      return tabId || '';
    }
  });
  const [wsStatus, setWsStatus] = useState<WsStatus>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [composerDraft, setComposerDraft] = useState('');
  const deferredComposerDraft = useDeferredValue(composerDraft);
  const [completionItems, setCompletionItems] = useState<CompletionItem[]>([]);

  const activeTabIdRef = useRef('');
  useEffect(() => { activeTabIdRef.current = activeTabId; }, [activeTabId]);

  const terminalConnection = useTerminalConnection(activeTabId);
  const { mode: inputMode, toggleMode } = useTerminalInputMode(activeTabId);

  useEffect(() => {
    if (!activeTabId) return;
    try {
      sessionStorage.setItem(STORAGE_KEY_ACTIVE_TAB, activeTabId);
    } catch {
      // sessionStorage 不可用只影响恢复上次标签，不影响当前终端。
    }
  }, [activeTabId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await listTabs(workspaceId);
        if (cancelled) return;
        const live = rows.map((tab) => ({
          id: tab.id,
          label: tab.label || deriveTabLabel(tab),
          status: tab.status === 'running' ? 'ready' : tab.status,
          cwd: tab.cwd,
        }));
        setTabs((prev) => mergeTabs(prev, live, tabId || ''));
        if (!activeTabIdRef.current && live[0]) setActiveTabId(live[0].id);
      } catch {
        if (!cancelled) setError('加载标签失败');
      }
    })();
    return () => { cancelled = true; };
  }, [workspaceId, tabId]);

  useEffect(() => {
    if (!activeTabId) return;
    queueMicrotask(() => {
      setComposerDraft('');
      setCompletionItems([]);
    });
    if (completionDebounceRef.current) {
      clearTimeout(completionDebounceRef.current);
      completionDebounceRef.current = null;
    }
    terminalRef.current?.write?.('\x1b[2J\x1b[3J\x1b[H');
    queueMicrotask(() => setWsStatus('connecting'));
    const unbind = terminalConnection.bindView({
      onOutput: (text) => terminalRef.current?.write?.(text),
      onState: (state) => {
        if (state === 'running') {
          setWsStatus('running');
          setError(null);
          setTabs((prev) => prev.map((tab) => (tab.id === activeTabId ? { ...tab, status: 'ready' } : tab)));
          return;
        }
        if (state === 'ended' || state === 'closed') {
          setWsStatus('exited');
          setTabs((prev) => prev.map((tab) => (tab.id === activeTabId ? { ...tab, status: 'exited' } : tab)));
          return;
        }
        if (state === 'error') {
          setWsStatus('error');
          setTabs((prev) => prev.map((tab) => (tab.id === activeTabId ? { ...tab, status: 'error' } : tab)));
        }
      },
      onError: () => setError('终端连接异常'),
    });
    return () => unbind();
  }, [activeTabId, terminalConnection]);

  useEffect(() => {
    if (completionDebounceRef.current) clearTimeout(completionDebounceRef.current);
    if (inputMode !== 'command' || deferredComposerDraft.length < 2) {
      queueMicrotask(() => setCompletionItems([]));
      return;
    }
    completionDebounceRef.current = setTimeout(async () => {
      try {
        const result = await queryCompletion({ prefix: deferredComposerDraft, limit: 8 });
        setCompletionItems(result.items);
      } catch {
        setCompletionItems([]);
      }
    }, COMPLETION_DEBOUNCE_MS);
    return () => {
      if (completionDebounceRef.current) clearTimeout(completionDebounceRef.current);
    };
  }, [deferredComposerDraft, inputMode]);

  const handleTerminalData = useCallback((data: string) => {
    if (inputMode === 'direct') {
      terminalConnection.sendInput(data);
    }
  }, [inputMode, terminalConnection]);

  const handleTerminalResize = useCallback((cols: number, rows: number) => {
    terminalConnection.resize(cols, rows);
  }, [terminalConnection]);

  const handleClearScreen = useCallback(() => {
    terminalRef.current?.write?.('\x1b[2J\x1b[3J\x1b[H');
  }, []);

  const handleTabSelect = useCallback((id: string) => {
    setActiveTabId(id);
  }, []);

  const handleTabClose = useCallback(async (id: string) => {
    const wasActive = id === activeTabIdRef.current;
    let nextActiveId = '';
    let shouldReturnHome = false;
    setTabs((prev) => {
      const remaining = prev.filter((tab) => tab.id !== id);
      if (wasActive) nextActiveId = remaining[0]?.id ?? '';
      // 关闭最后一个标签后离开终端页，避免留下没有会话的空终端壳。
      shouldReturnHome = wasActive && remaining.length === 0;
      return remaining;
    });
    if (wasActive) setActiveTabId(nextActiveId);
    try {
      await closeTab(id);
      await deleteTab(id);
      if (shouldReturnHome) router.push('/');
    } catch {
      setError('关闭标签失败');
    }
  }, [router]);

  const handleTabCreate = useCallback(async () => {
    if (tabs.length >= MAX_TABS || creatingTabRef.current) return;
    creatingTabRef.current = true;
    try {
      const { tab } = await createTab(workspaceId, { requestId: crypto.randomUUID() });
      const nextTab: TabInfo = {
        id: tab.id,
        label: tab.label || deriveTabLabel(tab),
        status: 'connecting',
        cwd: tab.cwd,
      };
      setTabs((prev) => [...prev, nextTab]);
      setActiveTabId(nextTab.id);
    } catch {
      setError('创建标签失败');
    } finally {
      creatingTabRef.current = false;
    }
  }, [tabs.length, workspaceId]);

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

  if (!workspaceId) {
    return (
      <div className="min-h-screen flex items-center justify-center text-[color:var(--color-accent-danger)]" data-testid="no-session">
        缺少 workspace 参数
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <div className="flex-1 flex flex-col min-w-0">
        <header
          className="flex items-center justify-between px-4 py-2 border-b border-[color:var(--color-border-subtle)] bg-[color:var(--color-bg-panel-strong)] backdrop-blur-md"
          style={{ WebkitBackdropFilter: 'blur(10px)' }}
        >
          <div className="flex items-center gap-3">
            <Link href="/" className="flex items-center gap-2 text-sm hover:opacity-80 transition-opacity" aria-label="返回首页">
              <TerminalLogo />
              <span className="font-semibold tracking-tight">nterminal</span>
            </Link>
            <span className="text-[color:var(--color-fg-quaternary)] text-xs">/</span>
            <span className={wsPillClass} data-testid="status">
              <span className="dot" />
              {wsStatusText}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={toggleMode}
              className="chip text-[10px] cursor-pointer hover:opacity-80 transition-opacity"
              data-testid="terminal-input-mode-toggle"
            >
              {inputMode === 'command' ? '命令模式' : '直通模式'}
            </button>
            <button
              type="button"
              onClick={handleClearScreen}
              className="chip text-[10px] cursor-pointer hover:opacity-80 transition-opacity"
              data-testid="clear-screen"
              title="清空终端可视区与回滚缓冲（不影响 PTY）"
            >
              清屏
            </button>
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

        <TabBar
          tabs={tabs}
          activeTabId={activeTabId}
          onTabSelect={handleTabSelect}
          onTabClose={handleTabClose}
          onTabCreate={handleTabCreate}
        />

        <div className="terminal-workspace-body flex-1 min-h-0 p-3 sm:p-5">
          <div className="poc-terminal terminal-workspace-body__terminal w-full max-w-[1100px]">
            <Terminal
              ref={terminalRef}
              onData={handleTerminalData}
              onResize={handleTerminalResize}
              className="h-full"
            />
          </div>
          <div className="terminal-workspace-body__composer w-full max-w-[1100px]">
            <TerminalComposer
              mode={inputMode}
              sendInput={terminalConnection.sendInput}
              completions={completionItems}
              onDraftChange={setComposerDraft}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function TerminalLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="2" y="3" width="20" height="14" rx="2.5" stroke="var(--color-accent)" strokeWidth="1.5" />
      <path
        d="M6 9 L9.5 12 L6 15"
        stroke="var(--color-accent-2)"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <line
        x1="11"
        y1="15"
        x2="15"
        y2="15"
        stroke="var(--color-accent-warn)"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
