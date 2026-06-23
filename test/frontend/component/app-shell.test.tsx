// @vitest-environment jsdom

import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AppShell from '../../../app/components/AppShell';

vi.mock('next/navigation', () => ({
  usePathname: () => '/terminal',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    ok: true,
    data: [{ id: 'H:/fixture', displayName: 'Fixture', sessionCount: 0, createdAt: '', lastActiveAt: '' }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
});

describe('AppShell', () => {
  it('终端页面仍展示工作区侧栏和全部一级入口', async () => {
    render(<AppShell><main>终端内容</main></AppShell>);
    expect(await screen.findByTestId('workspace-sidebar')).toBeTruthy();
    expect(screen.getByRole('link', { name: '概览' }).getAttribute('href')).toBe('/');
    expect(screen.getByRole('link', { name: '历史' }).getAttribute('href')).toBe('/history');
    expect(screen.getByRole('link', { name: '设置' }).getAttribute('href')).toBe('/settings');
    expect(screen.getByText('终端内容')).toBeTruthy();
  });
});
