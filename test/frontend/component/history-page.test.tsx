// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HistoryPage from '../../../app/components/HistoryPage';
import HistoryDetailPage from '../../../app/components/HistoryDetailPage';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

afterEach(() => cleanup());

const listPayload = {
  groups: [
    {
      sourceId: 'source-codex',
      agentType: 'codex',
      label: 'Codex',
      state: 'active',
      workspaces: [
        {
          cwd: 'H:/workspace/app',
          displayName: 'app',
          sessions: [
            {
              sessionKey: 'source-codex:native-a',
              sourceId: 'source-codex',
              nativeSessionId: 'native-a',
              cwd: 'H:/workspace/app',
              title: '修复终端输入',
              endedAt: '2026-06-23T09:03:00.000Z',
              messageCount: 3,
              snippet: '请修复终端输入',
            },
          ],
        },
      ],
    },
  ],
  pagination: { limit: 50, hasMore: false, searchMode: 'all', nextCursor: null },
  sourceStates: [
    { sourceId: 'source-codex', agentType: 'codex', label: 'Codex', path: 'H:/codex', state: 'active' },
    { sourceId: 'source-claude', agentType: 'claude', label: 'Claude', path: 'H:/claude', state: 'error', errorCode: 'SOURCE_MISSING', errorMessage: '来源目录不存在' },
  ],
};

const detailPayload = {
  session: {
    sessionKey: 'source-codex:native-a',
    sourceId: 'source-codex',
    nativeSessionId: 'native-a',
    cwd: 'H:/workspace/app',
    title: '修复终端输入',
    startedAt: '2026-06-23T09:00:00.000Z',
    endedAt: '2026-06-23T09:03:00.000Z',
    messageCount: 3,
  },
  source: { sourceId: 'source-codex', agentType: 'codex', label: 'Codex', path: 'H:/codex', state: 'active' },
  messages: [
    { id: 'm0', messageIndex: 0, role: 'user', content: '请修复终端输入', toolCalls: null, toolCallId: null, metadata: null, endedAt: '2026-06-23T09:00:00.000Z' },
    { id: 'm1', messageIndex: 1, role: 'assistant', content: '我会检查', toolCalls: '{"name":"read"}', toolCallId: 'tool-1', metadata: '{"phase":"analysis"}', endedAt: '2026-06-23T09:01:00.000Z' },
  ],
};

function mockApi() {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/history/sessions') {
      return new Response(JSON.stringify({ ok: true, data: listPayload }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/history/session') {
      return new Response(JSON.stringify({ ok: true, data: detailPayload }), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: false, error: { code: 'not_found', message: '未匹配' } }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }));
}

describe('HistoryPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockApi();
  });

  it('按来源、工作区和会话三层展示，并暴露 partial 来源错误', async () => {
    render(<HistoryPage />);

    expect(await screen.findByText('Codex')).toBeTruthy();
    expect(screen.getByText('H:/workspace/app')).toBeTruthy();
    expect(screen.getByText('修复终端输入')).toBeTruthy();
    expect(screen.getByText('Claude')).toBeTruthy();
    expect(screen.getByText('来源目录不存在')).toBeTruthy();
    expect(screen.getByRole('link', { name: /修复终端输入/ }).getAttribute('href')).toContain('/history/detail?sourceId=source-codex&sessionKey=source-codex%3Anative-a');
  });

  it('搜索提交使用会话级历史接口而不是旧 records 接口', async () => {
    render(<HistoryPage />);
    await screen.findByText('修复终端输入');

    fireEvent.change(screen.getByPlaceholderText('搜索会话、消息或工具内容'), { target: { value: '终端输入' } });
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));

    await waitFor(() => {
      const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some(([path]) => path === '/api/history/sessions')).toBe(true);
      expect(calls.some(([path]) => String(path).includes('/api/records/'))).toBe(false);
    });
  });
});

describe('HistoryDetailPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockApi();
  });

  it('展示会话详情、目录、原生会话和工具元数据，不暴露单消息删除', async () => {
    render(<HistoryDetailPage sourceId="source-codex" sessionKey="source-codex:native-a" />);

    expect(await screen.findByText('修复终端输入')).toBeTruthy();
    expect(screen.getByText('H:/workspace/app')).toBeTruthy();
    expect(screen.getByText('native-a')).toBeTruthy();
    expect(screen.getByText('请修复终端输入')).toBeTruthy();
    expect(screen.getByText('{"name":"read"}')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /删除/ })).toBeNull();
  });
});
