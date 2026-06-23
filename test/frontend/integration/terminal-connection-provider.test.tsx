// @vitest-environment jsdom

import React, { useEffect } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TerminalConnectionProvider,
  useTerminalConnection,
} from '../../../app/components/TerminalConnectionProvider';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;

  url: string;
  readyState = FakeWebSocket.CONNECTING;
  binaryType = 'blob';
  onopen: null | (() => void) = null;
  onclose: null | ((event: CloseEvent) => void) = null;
  onmessage: null | ((event: MessageEvent) => void) = null;
  onerror: null | (() => void) = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code: 1000 }));
  });

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
    });
  }
}

function TerminalView({ tabId }: { tabId: string }) {
  const terminal = useTerminalConnection(tabId);
  useEffect(() => terminal.bindView({ onOutput: vi.fn(), onState: vi.fn() }), [terminal]);
  return <button type="button" onClick={() => terminal.sendInput('x')}>send</button>;
}

function ObservedTerminalView({ tabId, onOutput }: { tabId: string; onOutput: (text: string) => void }) {
  const terminal = useTerminalConnection(tabId);
  useEffect(() => terminal.bindView({ onOutput, onState: vi.fn() }), [terminal, onOutput]);
  return <div>observed</div>;
}

function outputFrame(offset: number, text: string): ArrayBuffer {
  const payload = new TextEncoder().encode(text);
  const frame = new ArrayBuffer(9 + payload.byteLength);
  const view = new DataView(frame);
  view.setUint8(0, 0x01);
  view.setBigUint64(1, BigInt(offset));
  new Uint8Array(frame, 9).set(payload);
  return frame;
}

describe('TerminalConnectionProvider', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    FakeWebSocket.instances = [];
  });

  it('视图卸载不会关闭 socket，重新挂载同一 tab 复用连接', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const { rerender } = render(
      <TerminalConnectionProvider>
        <TerminalView tabId="tab-1" />
      </TerminalConnectionProvider>,
    );
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    rerender(<TerminalConnectionProvider><div>history page</div></TerminalConnectionProvider>);
    expect(FakeWebSocket.instances[0].close).not.toHaveBeenCalled();

    rerender(
      <TerminalConnectionProvider>
        <TerminalView tabId="tab-1" />
      </TerminalConnectionProvider>,
    );
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('同一帧内多个输出帧合并后再写入视图', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const onOutput = vi.fn();
    render(
      <TerminalConnectionProvider>
        <ObservedTerminalView tabId="tab-1" onOutput={onOutput} />
      </TerminalConnectionProvider>,
    );
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];

    socket.onmessage?.(new MessageEvent('message', { data: outputFrame(0, 'a') }));
    socket.onmessage?.(new MessageEvent('message', { data: outputFrame(1, 'b') }));

    await vi.waitFor(() => expect(onOutput).toHaveBeenCalledWith('ab'));
    expect(onOutput).toHaveBeenCalledTimes(1);
  });
});
