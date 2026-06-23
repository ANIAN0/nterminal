// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TerminalWorkspace from '../../../app/components/TerminalWorkspace';

const sendInputMock = vi.hoisted(() => vi.fn());
const terminalHandleMock = vi.hoisted(() => ({
  bindView: vi.fn(() => () => {}),
  sendInput: sendInputMock,
  resize: vi.fn(),
  status: 'running',
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('@wterm/react', () => {
  const FakeTerminal = React.forwardRef((props: { onData?: (data: string) => void; onReady?: (wt: unknown) => void }, ref) => {
    React.useImperativeHandle(ref, () => ({ write: vi.fn(), focus: vi.fn() }));
    React.useEffect(() => {
      props.onReady?.({
        element: document.createElement('div'),
        bridge: { getCursor: () => ({ visible: false, col: 0, row: 0 }) },
      });
    }, [props]);
    return (
      <button type="button" data-testid="fake-terminal" onClick={() => props.onData?.('\u001b[A')}>
        terminal
      </button>
    );
  });
  FakeTerminal.displayName = 'FakeTerminal';
  return { Terminal: FakeTerminal };
});

vi.mock('../../../app/components/TerminalConnectionProvider', () => ({
  useTerminalConnection: () => terminalHandleMock,
}));

vi.mock('../../../app/lib/api', () => ({
  listTabs: vi.fn(async () => [{ id: 'tab-1', label: 'tab-1', status: 'running', cwd: 'H:/fixture' }]),
  createTab: vi.fn(),
  closeTab: vi.fn(),
  deleteTab: vi.fn(),
  queryCompletion: vi.fn(async () => ({ items: [{ userText: 'npm test', count: 2, lastUsedAt: '' }] })),
}));

describe('TerminalWorkspace 输入闭环', () => {
  beforeEach(() => {
    sendInputMock.mockClear();
    terminalHandleMock.bindView.mockClear();
    terminalHandleMock.resize.mockClear();
    sessionStorage.clear();
  });

  afterEach(() => cleanup());

  it('使用底部 composer 提交命令，不再展示顶部伪 input 和右侧匹配面板', async () => {
    render(<TerminalWorkspace workspaceId="H:/fixture" tabId="tab-1" />);
    const input = await screen.findByTestId('terminal-composer-input');

    fireEvent.change(input, { target: { value: 'echo hi' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(sendInputMock).toHaveBeenCalledWith('echo hi\r');
    expect((input as HTMLTextAreaElement).value).toBe('');
    expect(screen.queryByTestId('input-buffer')).toBeNull();
    expect(screen.queryByTestId('search-results')).toBeNull();
  });

  it('直接模式原样转发 wterm onData，且不累计 composer 草稿', async () => {
    render(<TerminalWorkspace workspaceId="H:/fixture" tabId="tab-1" />);
    await screen.findByTestId('terminal-composer-input');

    fireEvent.click(screen.getByTestId('terminal-input-mode-toggle'));
    fireEvent.click(screen.getByTestId('fake-terminal'));

    expect(sendInputMock).toHaveBeenCalledWith('\u001b[A');
    await waitFor(() => expect((screen.getByTestId('terminal-composer-input') as HTMLTextAreaElement).value).toBe(''));
  });
});
