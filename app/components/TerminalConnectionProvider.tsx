'use client';

/**
 * 终端 WebSocket 连接与状态管理 Provider。
 * 为同一 tab 维护一个 ManagedConnection，按 rAF 把输出合并到一次刷帧，
 * 避免高频 data 事件触发整页重渲染；视图解绑不杀 socket，留给浏览器页面关闭/服务端回收。
 */

import React, { createContext, useContext, useMemo, useRef } from 'react';
import { createTerminalWsUrl, type TerminalConnectionState, type TerminalViewBinding } from '../lib/terminal-connection';
import { decodeOutputFrame, encodeResize, parseEnvelope } from '../lib/terminal-protocol';

interface ManagedConnection {
  tabId: string;
  socket: WebSocket;
  status: TerminalConnectionState;
  lastOffset: bigint;
  views: Set<TerminalViewBinding>;
  backlog: string[];
  pendingOutput: string[];
  flushScheduled: boolean;
}

interface TerminalConnectionHandle {
  bindView: (binding: TerminalViewBinding) => () => void;
  sendInput: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  status: TerminalConnectionState;
}

interface TerminalConnectionContextValue {
  getHandle: (tabId: string) => TerminalConnectionHandle;
}

const TerminalConnectionContext = createContext<TerminalConnectionContextValue | null>(null);

function notifyState(connection: ManagedConnection, state: TerminalConnectionState, details?: unknown) {
  connection.status = state;
  for (const view of connection.views) view.onState(state, details);
}

function notifyOutput(connection: ManagedConnection, text: string) {
  connection.backlog.push(text);
  if (connection.backlog.length > 2_000) connection.backlog.shift();
  for (const view of connection.views) view.onOutput(text);
}

function queueOutput(connection: ManagedConnection, text: string) {
  connection.pendingOutput.push(text);
  if (connection.flushScheduled) return;
  connection.flushScheduled = true;
  const schedule = typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 16);
  schedule(() => {
    connection.flushScheduled = false;
    const text = connection.pendingOutput.join('');
    connection.pendingOutput = [];
    if (text) notifyOutput(connection, text);
  });
}

export function TerminalConnectionProvider({ children }: { children: React.ReactNode }) {
  const connectionsRef = useRef<Map<string, ManagedConnection>>(new Map());

  const ensureConnection = (tabId: string): ManagedConnection => {
    const existing = connectionsRef.current.get(tabId);
    if (existing && existing.socket.readyState !== WebSocket.CLOSED) return existing;

    const connection = {
      tabId,
      socket: new WebSocket(createTerminalWsUrl(tabId, existing?.lastOffset ?? BigInt(0))),
      status: 'connecting' as TerminalConnectionState,
      lastOffset: existing?.lastOffset ?? BigInt(0),
      views: new Set<TerminalViewBinding>(),
      backlog: existing?.backlog ?? [],
      pendingOutput: [],
      flushScheduled: false,
    };
    connection.socket.binaryType = 'arraybuffer';
    connection.socket.onopen = () => notifyState(connection, 'running');
    connection.socket.onclose = () => {
      if (connection.status !== 'ended' && connection.status !== 'closed') notifyState(connection, 'closed');
    };
    connection.socket.onerror = () => notifyState(connection, 'error');
    connection.socket.onmessage = async (event) => {
      if (typeof event.data === 'string') {
        const envelope = parseEnvelope(event.data);
        if (envelope?.type === 'session_state') {
          notifyState(connection, String(envelope.state || 'ended') as TerminalConnectionState, envelope);
          return;
        }
        if (envelope?.type === 'error') {
          const message = typeof envelope.message === 'string' ? envelope.message : '终端连接错误';
          for (const view of connection.views) view.onError?.(message);
          notifyState(connection, 'error', envelope);
          return;
        }
        if (envelope?.type === 'hello') {
          notifyState(connection, 'running', envelope);
          return;
        }
        queueOutput(connection, event.data);
        return;
      }
      const data = event.data instanceof Blob ? await event.data.arrayBuffer() : event.data;
      const frame = decodeOutputFrame(data);
      if (frame.startOffset < connection.lastOffset) return;
      if (frame.startOffset > connection.lastOffset) {
        notifyState(connection, 'error', { code: 'CLIENT_OUTPUT_GAP' });
        connection.socket.close();
        connectionsRef.current.delete(tabId);
        return;
      }
      connection.lastOffset += BigInt(frame.payload.byteLength);
      queueOutput(connection, new TextDecoder().decode(frame.payload));
    };
    connectionsRef.current.set(tabId, connection);
    return connection;
  };

  const value = useMemo<TerminalConnectionContextValue>(() => ({
    getHandle: (tabId: string) => ({
      bindView: (binding: TerminalViewBinding) => {
        if (!tabId) return () => {};
        const connection = ensureConnection(tabId);
        connection.views.add(binding);
        for (const item of connection.backlog) binding.onOutput(item);
        binding.onState(connection.status);
        return () => {
          // 视图卸载只解绑消费者，socket 保持到浏览器页面关闭或服务端回收。
          connection.views.delete(binding);
        };
      },
      sendInput: (data: string) => {
        if (!tabId) return;
        const connection = ensureConnection(tabId);
        if (connection.socket.readyState === WebSocket.OPEN) connection.socket.send(data);
      },
      resize: (cols: number, rows: number) => {
        if (!tabId) return;
        const connection = ensureConnection(tabId);
        if (connection.socket.readyState === WebSocket.OPEN) connection.socket.send(encodeResize(cols, rows));
      },
      status: tabId ? ensureConnection(tabId).status : 'closed',
    }),
  }), []);

  return <TerminalConnectionContext.Provider value={value}>{children}</TerminalConnectionContext.Provider>;
}

export function useTerminalConnection(tabId: string): TerminalConnectionHandle {
  const context = useContext(TerminalConnectionContext);
  if (!context) throw new Error('useTerminalConnection 必须在 TerminalConnectionProvider 内使用');
  return useMemo(() => context.getHandle(tabId), [context, tabId]);
}
