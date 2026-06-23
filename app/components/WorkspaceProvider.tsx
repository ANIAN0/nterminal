'use client';

/**
 * 工作区列表 + 创建状态管理。
 * 通过 ref + 状态双层 pending 集合，保证同一动作在 React 提交前不会被并发点击触发两次。
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { postJson } from '../lib/api';

export interface WorkspaceView {
  id: string;
  displayName?: string | null;
  sessionCount?: number;
}

interface WorkspaceContextValue {
  workspaces: WorkspaceView[];
  pendingActions: Set<string>;
  error: string | null;
  createWorkspace: (cwd: string) => Promise<void>;
  reload: () => Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [workspaces, setWorkspaces] = useState<WorkspaceView[]>([]);
  const [pendingActions, setPendingActions] = useState(new Set<string>());
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(new Set<string>());

  const reload = useCallback(async () => {
    const items = await postJson<WorkspaceView[]>('/api/workspaces/list', {});
    setWorkspaces(items);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void postJson<WorkspaceView[]>('/api/workspaces/list', {}, { signal: controller.signal })
      .then(setWorkspaces)
      .catch((cause) => {
        if (cause?.name !== 'AbortError') setError('加载工作区失败');
      });
    return () => controller.abort();
  }, []);

  const createWorkspace = useCallback(async (cwd: string) => {
    const action = 'create-workspace';
    // ref 在同一事件循环内立即生效，避免 React 状态提交前的第二次点击穿透。
    if (pendingRef.current.has(action)) return;
    pendingRef.current.add(action);
    setPendingActions(new Set(pendingRef.current));
    setError(null);
    try {
      await postJson('/api/workspaces/create', { cwd, requestId: crypto.randomUUID() });
      await reload();
    } catch {
      setError('创建工作区失败');
    } finally {
      pendingRef.current.delete(action);
      setPendingActions(new Set(pendingRef.current));
    }
  }, [reload]);

  return (
    <WorkspaceContext.Provider value={{ workspaces, pendingActions, error, createWorkspace, reload }}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace 必须位于 WorkspaceProvider 内');
  return value;
}
