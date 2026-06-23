// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TerminalComposer from '../../../app/components/TerminalComposer';

afterEach(() => cleanup());

describe('TerminalComposer', () => {
  it('命令模式 Enter 发送 text+CR 且立即清空输入', () => {
    const sendInput = vi.fn();
    render(<TerminalComposer mode="command" sendInput={sendInput} completions={[]} />);
    const input = screen.getByTestId('terminal-composer-input') as HTMLTextAreaElement;

    fireEvent.change(input, { target: { value: 'echo 1' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(sendInput).toHaveBeenCalledTimes(1);
    expect(sendInput).toHaveBeenCalledWith('echo 1\r');
    expect(input.value).toBe('');
  });

  it('IME 组合输入期间 Enter 不提交，compositionEnd 后才按文本提交', () => {
    const sendInput = vi.fn();
    render(<TerminalComposer mode="command" sendInput={sendInput} completions={[]} />);
    const input = screen.getByTestId('terminal-composer-input') as HTMLTextAreaElement;

    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: '中文' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(sendInput).not.toHaveBeenCalled();

    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(sendInput).toHaveBeenCalledWith('中文\r');
  });

  it('补全选择只填入输入框，不直接发送命令', () => {
    const sendInput = vi.fn();
    render(<TerminalComposer mode="command" sendInput={sendInput} completions={[{ userText: 'npm test', count: 3, lastUsedAt: '' }]} />);

    fireEvent.click(screen.getByText('npm test'));

    expect(sendInput).not.toHaveBeenCalled();
    expect((screen.getByTestId('terminal-composer-input') as HTMLTextAreaElement).value).toBe('npm test');
    expect(screen.getAllByTestId('completion-panel')).toHaveLength(1);
  });
});
