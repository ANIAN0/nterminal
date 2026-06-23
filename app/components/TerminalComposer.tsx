'use client';

/**
 * 终端命令输入面板。
 * 命令模式下敲入文本只在提交瞬间把整行和 CR 传给 PTY，
 * 避免 IME 组字期按字符落到终端导致乱码；直通模式由 TerminalWorkspace 自身处理按键转发。
 */

import { useRef, useState } from 'react';
import type { CompletionItem } from '../lib/types';

export type TerminalInputMode = 'command' | 'direct';

interface TerminalComposerProps {
  mode: TerminalInputMode;
  sendInput: (data: string) => void;
  completions: CompletionItem[];
  onDraftChange?: (value: string) => void;
}

export default function TerminalComposer({ mode, sendInput, completions, onDraftChange }: TerminalComposerProps) {
  const [draft, setDraft] = useState('');
  const composingRef = useRef(false);

  function updateDraft(value: string) {
    setDraft(value);
    onDraftChange?.(value);
  }

  function submit() {
    const text = draft;
    if (!text) return;
    // 命令模式只在提交瞬间把整行和 CR 传给 PTY，避免输入期间累计到终端。
    sendInput(`${text}\r`);
    updateDraft('');
  }

  return (
    <div className="terminal-composer" data-mode={mode} data-testid="terminal-composer">
      <textarea
        data-testid="terminal-composer-input"
        value={draft}
        rows={1}
        aria-label="终端命令输入"
        disabled={mode === 'direct'}
        onChange={(event) => updateDraft(event.currentTarget.value)}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => { composingRef.current = false; }}
        onKeyDown={(event) => {
          if (mode !== 'command') return;
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            if (!composingRef.current) submit();
          }
        }}
      />
      {completions.length > 0 && (
        <div data-testid="completion-panel" className="terminal-composer__completion">
          {completions.map((item) => (
            <button
              type="button"
              key={item.userText}
              onClick={() => updateDraft(item.userText)}
            >
              {item.userText}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
