// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SettingsPage from '../../../app/settings/page';

const sources = [
  {
    id: 'source-ok',
    path: 'H:/sources/codex',
    agentType: 'codex',
    label: 'Codex',
    lastSyncedAt: '2026-06-23T09:00:00.000Z',
    lastSuccessAt: '2026-06-23T09:00:00.000Z',
    recordCount: 2,
    status: 'active',
    syncState: 'active',
  },
  {
    id: 'source-error',
    path: 'C:/Users/me/.local/share/opencode/opencode.db',
    agentType: 'opencode',
    label: 'OpenCode',
    lastSyncedAt: null,
    lastSuccessAt: null,
    recordCount: 0,
    status: 'error',
    syncState: 'error',
    lastErrorCode: 'SOURCE_SCHEMA',
    lastErrorMessage: '对话来源结构不受支持',
    lastErrorAt: '2026-06-23T10:00:00.000Z',
  },
];

afterEach(() => cleanup());

function mockSettingsApi() {
  let resolveSync: ((response: Response) => void) | null = null;
  const fetchMock = vi.fn((path: string) => {
    if (path === '/api/conversation-sources') {
      return Promise.resolve(new Response(JSON.stringify({ ok: true, data: { items: sources } }), { headers: { 'Content-Type': 'application/json' } }));
    }
    if (path === '/api/conversation-sources/source-error/sync') {
      return new Promise<Response>((resolve) => { resolveSync = resolve; });
    }
    if (path === '/api/conversation-sources/source-ok/sync') {
      return Promise.resolve(new Response(JSON.stringify({ ok: true, data: { sourceId: 'source-ok', state: 'active', inserted: 2, updated: 0, deleted: 0 } }), { headers: { 'Content-Type': 'application/json' } }));
    }
    return Promise.resolve(new Response(JSON.stringify({ ok: false, error: { code: 'not_found', message: '未匹配' } }), { status: 404, headers: { 'Content-Type': 'application/json' } }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, resolveSync: (response: Response) => resolveSync?.(response) };
}

describe('SettingsPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('逐来源展示状态、路径、上次成功和安全错误，并可对错误来源重试', async () => {
    mockSettingsApi();
    render(<SettingsPage />);

    expect(await screen.findByText('Codex')).toBeTruthy();
    expect(screen.getAllByText('OpenCode').length).toBeGreaterThan(0);
    expect(screen.getByText('H:/sources/codex')).toBeTruthy();
    expect(screen.getByText('C:/Users/me/.local/share/opencode/opencode.db')).toBeTruthy();
    expect(screen.getByText(/最后成功/)).toBeTruthy();
    expect(screen.getByText('SOURCE_SCHEMA')).toBeTruthy();
    expect(screen.getByText('对话来源结构不受支持')).toBeTruthy();
    expect(screen.getByTestId('sync-source-source-error').textContent).toContain('重试');
  });

  it('同一来源重复点击只发一次请求，其他来源按钮不被禁用', async () => {
    const api = mockSettingsApi();
    render(<SettingsPage />);
    await screen.findByText('OpenCode');

    const errorSync = screen.getByTestId('sync-source-source-error') as HTMLButtonElement;
    const okSync = screen.getByTestId('sync-source-source-ok') as HTMLButtonElement;
    fireEvent.click(errorSync);
    fireEvent.click(errorSync);

    expect(api.fetchMock.mock.calls.filter(([path]) => path === '/api/conversation-sources/source-error/sync')).toHaveLength(1);
    expect(errorSync.disabled).toBe(true);
    expect(okSync.disabled).toBe(false);

    api.resolveSync(new Response(JSON.stringify({ ok: true, data: { sourceId: 'source-error', state: 'active', inserted: 1, updated: 0, deleted: 0 } }), { headers: { 'Content-Type': 'application/json' } }));
    await waitFor(() => expect(errorSync.disabled).toBe(false));
  });

  it('同步全部逐来源触发并汇总结果', async () => {
    const api = mockSettingsApi();
    render(<SettingsPage />);
    await screen.findByText('OpenCode');

    fireEvent.click(screen.getByRole('button', { name: '同步全部' }));

    await waitFor(() => expect(api.fetchMock.mock.calls.some(([path]) => path === '/api/conversation-sources/source-ok/sync')).toBe(true));
    expect((screen.getByRole('button', { name: /同步全部/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
