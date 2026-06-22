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
import { Terminal, type TerminalHandle } from '@wterm/react';
import type { WTerm } from '@wterm/dom';
import { searchRecords, queryCompletion, createSession, killSession, listSessions } from '../lib/api';
import type { RecordSearchItem, CompletionItem, TabInfo, Workspace, SessionInfo } from '../lib/types';
import { MAX_TABS } from '../lib/types';
import CompletionPanel from './CompletionPanel';
import TabBar from './TabBar';
import WorkspaceSidebar from './WorkspaceSidebar';

// 状态机：终端页状态
type WsStatus = 'connecting' | 'running' | 'exited' | 'error';
type MatchStatus = 'idle' | 'match_pending' | 'match_results' | 'match_empty' | 'match_error' | 'cancelled';

const SEARCH_DEBOUNCE_MS = 150;
const COMPLETION_DEBOUNCE_MS = 150;
// MAX_TABS 来源统一在 lib/types.ts（与后端 session_limit_reached=8 对齐）
// 标签状态（tab.id 与后端 PTY sessionId 一致）做 sessionStorage 恢复
// 注意：刷新页面后只恢复 activeTabId，不重建后端 PTY。
const STORAGE_KEY_ACTIVE_TAB = 'nterminal_active_tab';

function isPrintable(ch: string): boolean {
  return ch >= ' ' && ch !== '\x1b' && ch !== '\x7f';
}

function looksLikeJsonEnvelope(s: string): boolean {
  if (!s.startsWith('{') || s.length > 2000) return false;
  try {
    const obj = JSON.parse(s);
    return obj != null && typeof obj === 'object' && (typeof obj.type === 'string' || typeof obj._ctrl === 'object');
  } catch {
    return false;
  }
}

/**
 * 派生标签名：优先用 cwd 的最后一段（如 "…/my-tool" → "my-tool"），
 * 兜底用 sessionId 前 8 位。
 */
function deriveTabLabel(s: { id: string; cwd?: string }): string {
  if (s.cwd) {
    const parts = s.cwd.split(/[\\/]/).filter(Boolean);
    const last = parts[parts.length - 1];
    if (last) return last;
  }
  return s.id.slice(0, 8);
}

/**
 * 合并 tabs：
 * - live（来自 /api/session/list 的真值）覆盖相同 id 的条目（cwd/status 用后端权威值）
 * - prev 里独有的条目保留（如尚未在后端列表中上报的、刚创建还未 ready 的）
 * - seedSessionId（URL 上的）保证至少有一个 tab
 */
function mergeTabs(prev: TabInfo[], live: TabInfo[], seedSessionId: string): TabInfo[] {
  const byId = new Map<string, TabInfo>();
  for (const t of prev) byId.set(t.id, t);
  for (const t of live) byId.set(t.id, t);
  if (seedSessionId && !byId.has(seedSessionId)) {
    byId.set(seedSessionId, { id: seedSessionId, label: seedSessionId.slice(0, 8), status: 'connecting' });
  }
  return Array.from(byId.values());
}

export default function TerminalWorkspace({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const terminalRef = useRef<TerminalHandle | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // IME 光标锚定（#2/#9）：把 wterm 内部隐藏 textarea 移到真实光标像素位置，
  // 使拼音候选窗跟随光标、且消除离屏 textarea 触发的页面跳动。
  const wtRef = useRef<WTerm | null>(null);
  const imeRafRef = useRef<number | null>(null);
  const charWidthRef = useRef<number>(0);

  const [inputBuffer, setInputBuffer] = useState('');
  const deferredBuffer = useDeferredValue(inputBuffer);

  const [wsStatus, setWsStatus] = useState<WsStatus>('connecting');
  const [error, setError] = useState<string | null>(null);

  const [searchResults, setSearchResults] = useState<RecordSearchItem[]>([]);
  const [matchStatus, setMatchStatus] = useState<MatchStatus>('idle');

  // ---- 补全状态 ----
  const [completionItems, setCompletionItems] = useState<CompletionItem[]>([]);
  const [completionHighlight, setCompletionHighlight] = useState(-1);
  const [showCompletion, setShowCompletion] = useState(false);
  const completionDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- 标签状态（sessionStorage 恢复） ----
  // tab.id 必须等于后端 PTY sessionId（C-009 隐含约束，本期明确化）
  const [tabs, setTabs] = useState<TabInfo[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY_ACTIVE_TAB);
      // 新格式只存 activeTabId；tabs 列表从 /api/session/list 重建
      return [];
    } catch {
      return [];
    }
  });
  const [activeTabId, setActiveTabId] = useState<string>(() => {
    if (typeof window === 'undefined') return sessionId;
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY_ACTIVE_TAB);
      // 优先用 URL 的 sessionId（路由语义优先），否则用上次活跃
      return sessionId || (stored ?? '');
    } catch {
      return sessionId;
    }
  });

  // ---- 工作区状态（纯内存，与 C-010 一致，不持久化） ----
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // ---- 持久化：仅存 activeTabId ----
  useEffect(() => {
    if (activeTabId) {
      sessionStorage.setItem(STORAGE_KEY_ACTIVE_TAB, activeTabId);
    }
  }, [activeTabId]);

  // tabsRef 供 close 等需要在闭包里读到最新 tabs 列表的场景使用
  const tabsRef = useRef<TabInfo[]>([]);
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);
  // activeTabIdRef 用于 setTabs 等函数式回调里读到最新 activeTabId（避免闭包过期）
  const activeTabIdRef = useRef<string>('');
  useEffect(() => { activeTabIdRef.current = activeTabId; }, [activeTabId]);

  // ---- 初次挂载：拉取后端活跃会话，初始化 tabs ----
  // （页面刷新或直访 /terminal?sessionId=xxx 时落地）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await listSessions();
        if (cancelled) return;
        // 后端活跃列表里的都视为"已 ready"，保留它们的 id/cwd
        const live: TabInfo[] = r.sessions.map((s) => ({
          id: s.id,
          label: deriveTabLabel(s),
          status: 'ready',
          cwd: s.cwd,
        }));
        setTabs((prev) => mergeTabs(prev, live, sessionId));
      } catch (err) {
        // 拉取失败不阻塞页面（可能是首次启动无活跃会话）
        if (!cancelled) console.warn('listSessions failed', err);
      }
    })();
    return () => { cancelled = true; };
    // 仅首次挂载执行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- WS 连接：跟随 activeTabId 切换 PTY ----
  useEffect(() => {
    if (!activeTabId) return;

    // 切标签时清理上一个 PTY 的 UI 状态，防止输入/补全/搜索状态泄漏到新 PTY
    setInputBuffer('');
    setSearchResults([]);
    setMatchStatus('idle');
    setShowCompletion(false);
    setCompletionItems([]);
    setCompletionHighlight(-1);
    // 取消进行中的搜索/补全 debounce 与 fetch
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (completionDebounceRef.current) {
      clearTimeout(completionDebounceRef.current);
      completionDebounceRef.current = null;
    }
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    // 切到新 PTY 前先清屏（避免上一个 PTY 的输出残留）
    // 等 wterm 真正 ready 之后再清，避免 onReady 还没触发就 write
    const clearOnceReady = () => {
      terminalRef.current?.write?.('\x1b[2J\x1b[3J\x1b[H');
    };
    // 立即尝试一次（多数情况下 wterm 已 ready），延迟再尝试兜底
    clearOnceReady();
    const clearTimer = setTimeout(clearOnceReady, 80);

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/ws/pty/${activeTabId}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;
    setWsStatus('connecting');

    ws.onopen = () => {
      setWsStatus('running');
      setError(null);
      // 同步 tab 状态
      setTabs((prev) => prev.map((t) => (t.id === activeTabId ? { ...t, status: 'ready' } : t)));
    };
    ws.onclose = (ev) => {
      setWsStatus('exited');
      setError(null);
      // 404/409 等异常关闭时把 tab 标为 exited（保留只读视图）
      if (ev.code !== 1000) {
        setTabs((prev) => prev.map((t) => (t.id === activeTabId ? { ...t, status: 'exited' } : t)));
      }
    };
    ws.onerror = () => {
      setWsStatus('error');
      setError('WS 连接错误');
      setTabs((prev) => prev.map((t) => (t.id === activeTabId ? { ...t, status: 'error' } : t)));
    };
    ws.onmessage = async (ev) => {
      const data = ev.data;
      if (typeof data === 'string') {
        if (looksLikeJsonEnvelope(data)) return;
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
      clearTimeout(clearTimer);
      ws.close();
    };
  }, [activeTabId]);

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

  // ---- IME 锚定清理 ----
  useEffect(() => {
    return () => {
      if (imeRafRef.current != null) cancelAnimationFrame(imeRafRef.current);
      imeRafRef.current = null;
      const cleanup = (wtRef as unknown as { _imeCleanup?: () => void })._imeCleanup;
      if (cleanup) cleanup();
    };
  }, []);

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

  // ---- 补全查询（debounce） ----
  useEffect(() => {
    if (completionDebounceRef.current) clearTimeout(completionDebounceRef.current);

    if (deferredBuffer.length < 2) {
      setShowCompletion(false);
      setCompletionItems([]);
      return;
    }

    completionDebounceRef.current = setTimeout(async () => {
      try {
        const r = await queryCompletion({ prefix: deferredBuffer, limit: 8 });
        if (r.items.length > 0) {
          setCompletionItems(r.items);
          setCompletionHighlight(0);
          setShowCompletion(true);
        } else {
          setShowCompletion(false);
          setCompletionItems([]);
        }
      } catch {
        setShowCompletion(false);
      }
    }, COMPLETION_DEBOUNCE_MS);

    return () => {
      if (completionDebounceRef.current) clearTimeout(completionDebounceRef.current);
    };
  }, [deferredBuffer]);

  // ---- 补全选择 ----
  const handleCompletionSelect = useCallback((text: string) => {
    setInputBuffer(text);
    setShowCompletion(false);
    setCompletionItems([]);
  }, []);

  const handleCompletionCancel = useCallback(() => {
    setShowCompletion(false);
    setCompletionItems([]);
  }, []);

  // 鼠标 hover 同步高亮索引，让键盘高亮与鼠标悬停互通
  const handleCompletionHover = useCallback((index: number) => {
    setCompletionHighlight(index);
  }, []);

  // ---- 键盘导航（补全面板） ----
  const handleCompletionKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!showCompletion || completionItems.length === 0) return;

      switch (e.key) {
        case 'Tab':
          e.preventDefault();
          if (completionHighlight < completionItems.length - 1) {
            setCompletionHighlight((prev) => prev + 1);
          }
          break;
        case 'ArrowDown':
          e.preventDefault();
          setCompletionHighlight((prev) =>
            prev < completionItems.length - 1 ? prev + 1 : 0,
          );
          break;
        case 'ArrowUp':
          e.preventDefault();
          setCompletionHighlight((prev) =>
            prev > 0 ? prev - 1 : completionItems.length - 1,
          );
          break;
        case 'Enter':
          e.preventDefault();
          if (completionHighlight >= 0 && completionHighlight < completionItems.length) {
            handleCompletionSelect(completionItems[completionHighlight].userText);
          }
          break;
        case 'Escape':
          e.preventDefault();
          handleCompletionCancel();
          break;
      }
    },
    [showCompletion, completionItems, completionHighlight, handleCompletionSelect, handleCompletionCancel],
  );

  // ---- 补全键盘导航 ----
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (showCompletion && completionItems.length > 0) {
        handleCompletionKeyDown(e);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [showCompletion, completionItems, handleCompletionKeyDown]);

  // ---- 标签管理 ----
  // 标签 = PTY 会话；handleTabCreate 调 createSession，handleTabClose 调 killSession。
  // cwd 缺省用 process.cwd()（后端 handleCreateSession 的兜底）。
  const handleTabSelect = useCallback((id: string) => {
    setActiveTabId(id);
  }, []);

  const handleTabClose = useCallback(async (id: string) => {
    // 用 setTabs 函数式回调同步推导新的 activeTabId，避免依赖 tabsRef 时序
    let nextActiveId: string | null = null;
    setTabs((prev) => {
      const remaining = prev.filter((t) => t.id !== id);
      // 关闭的就是当前活跃时，回退到首个剩余标签
      if (id === activeTabIdRef.current) {
        nextActiveId = remaining[0]?.id ?? null;
      }
      return remaining;
    });
    // 工作区里同步清掉这个 sessionId
    setWorkspaces((prev) =>
      prev.map((ws) => ({ ...ws, sessionIds: ws.sessionIds.filter((sid) => sid !== id) })),
    );
    // 同步切到下一个活跃（如果有），避免短暂指向已关闭 tab
    if (nextActiveId !== null) {
      setActiveTabId(nextActiveId ?? '');
    }
    // 后端杀进程（失败也不阻塞 UI；后端进程可能早已退出）
    try {
      await killSession(id);
    } catch (err) {
      console.warn('killSession failed', err);
    }
  }, []);

  const handleTabCreate = useCallback(async () => {
    if (tabs.length >= MAX_TABS) return;
    try {
      const { session } = await createSession({ cwd: '' });
      const newTab: TabInfo = {
        id: session.id,
        label: deriveTabLabel(session),
        status: 'connecting',
        cwd: session.cwd,
      };
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(newTab.id);
    } catch (err) {
      console.error('createSession failed', err);
      setError(err instanceof Error ? err.message : '创建标签失败');
    }
  }, [tabs.length]);

  // 侧边栏点击会话 = 切换到对应标签
  const handleSessionSelect = useCallback((id: string) => {
    setActiveTabId(id);
  }, []);

  // ---- 工作区管理 ----
  const handleWorkspaceCreate = useCallback((name: string) => {
    const ws: Workspace = {
      id: crypto.randomUUID(),
      name,
      sessionIds: [],
    };
    setWorkspaces((prev) => [...prev, ws]);
  }, []);

  const handleWorkspaceRename = useCallback((id: string, name: string) => {
    setWorkspaces((prev) =>
      prev.map((ws) => (ws.id === id ? { ...ws, name } : ws)),
    );
  }, []);

  const handleWorkspaceDelete = useCallback((id: string) => {
    if (!confirm('确定删除此工作区？')) return;
    setWorkspaces((prev) => prev.filter((ws) => ws.id !== id));
  }, []);

  const handleSessionDrop = useCallback((sessionId: string, workspaceId: string) => {
    setWorkspaces((prev) =>
      prev.map((ws) =>
        ws.id === workspaceId && !ws.sessionIds.includes(sessionId)
          ? { ...ws, sessionIds: [...ws.sessionIds, sessionId] }
          : ws,
      ),
    );
  }, []);

  // 测量单字符宽度（monospace），用于把 textarea 锚定到光标列。
  function measureCharWidth(wt: WTerm): number {
    try {
      const row = document.createElement('div');
      row.className = 'term-row';
      row.style.visibility = 'hidden';
      row.style.position = 'absolute';
      const probe = document.createElement('span');
      probe.textContent = 'W';
      row.appendChild(probe);
      wt.element.appendChild(row);
      const w = probe.getBoundingClientRect().width;
      row.remove();
      if (w > 0) return w;
    } catch { /* ignore */ }
    return 0;
  }

  // 每帧把隐藏 textarea 移到当前光标像素位置（仅终端聚焦时）。
  function repositionImeTextarea(wt: WTerm) {
    const ta = wt.element.querySelector('textarea');
    if (!ta) return;
    const bridge = wt.bridge;
    if (!bridge) return;
    const focused = wt.element.classList.contains('focused');
    if (!focused) return;
    const cursor = bridge.getCursor();
    const rowH = (wt as unknown as { _rowHeight?: number })._rowHeight || 18;
    let charW = charWidthRef.current || measureCharWidth(wt);
    if (charW > 0) charWidthRef.current = charW;
    if (!cursor || !cursor.visible || charW <= 0) return;
    const cs = getComputedStyle(wt.element);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padT = parseFloat(cs.paddingTop) || 0;
    let left = padL + cursor.col * charW;
    let top = padT + cursor.row * rowH;
    // 夹在可视区内，避免越界触发滚动
    const maxLeft = Math.max(0, wt.element.clientWidth - charW - padL);
    const maxTop = Math.max(0, wt.element.clientHeight - rowH - padT);
    if (left > maxLeft) left = maxLeft;
    if (top > maxTop) top = maxTop;
    const s = ta.style;
    s.left = `${Math.round(left)}px`;
    s.top = `${Math.round(top)}px`;
    s.width = `${Math.round(charW)}px`;
    s.height = `${Math.round(rowH)}px`;
  }

  const handleTerminalReady = useCallback((wt: WTerm) => {
    wtRef.current = wt;
    charWidthRef.current = 0; // 容器尺寸/字体变化后重测
    measureCharWidth(wt);
    const ta = wt.element.querySelector('textarea');
    const tick = () => {
      const w = wtRef.current;
      if (!w) return;
      repositionImeTextarea(w);
      imeRafRef.current = requestAnimationFrame(tick);
    };
    const start = () => {
      if (imeRafRef.current == null) {
        // 立即定位一次，再启动循环
        repositionImeTextarea(wt);
        imeRafRef.current = requestAnimationFrame(tick);
      }
    };
    const stop = () => {
      if (imeRafRef.current != null) {
        cancelAnimationFrame(imeRafRef.current);
        imeRafRef.current = null;
      }
    };
    if (ta) {
      ta.addEventListener('focus', start);
      ta.addEventListener('blur', stop);
    }
    // 清理句柄挂到 wtRef 上以便卸载时移除
    (wtRef as unknown as { _imeCleanup?: () => void })._imeCleanup = () => {
      stop();
      if (ta) {
        ta.removeEventListener('focus', start);
        ta.removeEventListener('blur', stop);
      }
    };
  }, []);

  // 清屏：清 wterm 可视区 + scrollback（不触碰 PTY 状态，prompt 下次输出重绘）
  const handleClearScreen = useCallback(() => {
    terminalRef.current?.write?.('\x1b[2J\x1b[3J\x1b[H');
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

  // 把真实 tabs 投影成 sidebar 需要的 {id,label} 形状（按 cwd 派生的可读标签）
  const sidebarSessions = tabs.map((t) => ({ id: t.id, label: t.label }));

  return (
    <div className="flex h-screen overflow-hidden">
      {/* 左侧工作区侧边栏 —— sessions 用真实 PTY id，tab.id === sessionId */}
      <WorkspaceSidebar
        workspaces={workspaces}
        sessions={sidebarSessions}
        onWorkspaceCreate={handleWorkspaceCreate}
        onWorkspaceRename={handleWorkspaceRename}
        onWorkspaceDelete={handleWorkspaceDelete}
        onSessionDrop={handleSessionDrop}
        onSessionSelect={handleSessionSelect}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed((p) => !p)}
      />

      <div className="flex-1 flex flex-col min-w-0">
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
            <a
              href="/settings"
              className="text-[11px] text-[color:var(--color-fg-tertiary)] hover:text-[color:var(--color-fg-primary)] transition-colors"
            >
              设置
            </a>
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

      {/* 标签栏 */}
      <TabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onTabSelect={handleTabSelect}
        onTabClose={handleTabClose}
        onTabCreate={handleTabCreate}
      />

      {/* 终端主体 —— 居中卡片 */}
      <div className="flex-1 relative p-3 sm:p-5 flex items-stretch justify-center min-h-0">
        <div className="poc-terminal w-full max-w-[1100px]">
          <Terminal
            ref={terminalRef}
            onData={handleTerminalData}
            onResize={handleTerminalResize}
            onReady={handleTerminalReady}
            className="h-full"
          />
        </div>

        {/* 补全面板（输入框下方） */}
        {showCompletion && completionItems.length > 0 && (
          <div
            className="absolute bottom-3 left-3 sm:left-5 w-[340px] max-h-[300px] flex flex-col overflow-hidden rounded-xl border border-[color:var(--color-border-strong)] shadow-2xl"
            style={{
              background: 'var(--color-bg-panel-strong)',
              backdropFilter: 'blur(14px)',
              WebkitBackdropFilter: 'blur(14px)',
            }}
            data-testid="completion-panel"
          >
            <div className="px-3 py-2 border-b border-[color:var(--color-border-subtle)]">
              <span className="text-[11px] text-[color:var(--color-fg-tertiary)]">补全建议</span>
            </div>
            <CompletionPanel
              items={completionItems}
              onSelect={handleCompletionSelect}
              onCancel={handleCompletionCancel}
              onHover={handleCompletionHover}
              highlightedIndex={completionHighlight}
            />
          </div>
        )}

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