// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceProvider, useWorkspace } from '../../../app/components/WorkspaceProvider';

function Harness() {
  const workspace = useWorkspace();
  return (
    <div>
      <button
        type="button"
        onClick={() => void workspace.createWorkspace('H:/fixture')}
        disabled={workspace.pendingActions.has('create-workspace')}
      >
        创建
      </button>
      <span>{workspace.error || ''}</span>
    </div>
  );
}

describe('WorkspaceProvider 操作状态', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => cleanup());

  it('快速双击只发一个创建请求，完成后恢复按钮', async () => {
    let resolveCreate: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn((path: string) => {
      if (path === '/api/workspaces/list') {
        return Promise.resolve(new Response(JSON.stringify({ ok: true, data: [] }), { headers: { 'Content-Type': 'application/json' } }));
      }
      return new Promise<Response>((resolve) => { resolveCreate = resolve; });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<WorkspaceProvider><Harness /></WorkspaceProvider>);
    const button = screen.getByRole('button', { name: '创建' });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/workspaces/create')).toHaveLength(1);
    resolveCreate?.(new Response(JSON.stringify({ ok: true, data: { workspace: { id: 'H:/fixture' }, deduplicated: false } }), { headers: { 'Content-Type': 'application/json' } }));
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  });

  it('失败显示安全错误且按钮恢复可重试', async () => {
    vi.stubGlobal('fetch', vi.fn(async (path: string) => new Response(JSON.stringify(
      path === '/api/workspaces/list'
        ? { ok: true, data: [] }
        : { ok: false, error: { code: 'INVALID_CWD', message: '目录不可用' } },
    ), { status: path === '/api/workspaces/list' ? 200 : 400, headers: { 'Content-Type': 'application/json' } })));

    render(<WorkspaceProvider><Harness /></WorkspaceProvider>);
    const button = screen.getByRole('button', { name: '创建' });
    fireEvent.click(button);

    expect(await screen.findByText('创建工作区失败')).toBeTruthy();
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
});
