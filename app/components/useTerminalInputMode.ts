'use client';

/**
 * 单 tab 维度的输入模式（命令 / 直通）状态钩子。
 * 模式按 tabId 持久化到 sessionStorage，刷新或重连后能恢复上次选择。
 */

import { useCallback, useEffect, useState } from 'react';
import type { TerminalInputMode } from './TerminalComposer';

const STORAGE_KEY = 'nterminal_terminal_input_mode';

function readStoredMode(tabId: string): TerminalInputMode {
  if (typeof window === 'undefined' || !tabId) return 'command';
  try {
    const stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '{}') as Record<string, TerminalInputMode>;
    return stored[tabId] === 'direct' ? 'direct' : 'command';
  } catch {
    return 'command';
  }
}

function writeStoredMode(tabId: string, mode: TerminalInputMode) {
  if (typeof window === 'undefined' || !tabId) return;
  try {
    const stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '{}') as Record<string, TerminalInputMode>;
    stored[tabId] = mode;
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // 存储失败只影响记忆，不影响当前输入模式。
  }
}

export function useTerminalInputMode(tabId: string) {
  const [mode, setModeState] = useState<TerminalInputMode>(() => readStoredMode(tabId));

  useEffect(() => {
    queueMicrotask(() => setModeState(readStoredMode(tabId)));
  }, [tabId]);

  const setMode = useCallback((nextMode: TerminalInputMode) => {
    setModeState(nextMode);
    writeStoredMode(tabId, nextMode);
  }, [tabId]);

  const toggleMode = useCallback(() => {
    setModeState((current) => {
      const nextMode = current === 'command' ? 'direct' : 'command';
      writeStoredMode(tabId, nextMode);
      return nextMode;
    });
  }, [tabId]);

  return { mode, setMode, toggleMode };
}
