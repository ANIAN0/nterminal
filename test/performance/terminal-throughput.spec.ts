import { test, expect, type Page } from 'playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let server: ChildProcessWithoutNullStreams | null = null;
let dataDir = '';
const port = 3221;
const baseUrl = `http://127.0.0.1:${port}`;

async function waitForReady() {
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    try {
      const response = await fetch(`${baseUrl}/api/workspaces/list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (response.ok) return;
    } catch {
      // 服务尚未监听时继续等待。
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('server_not_ready');
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} ${response.status} ${text}`);
  return JSON.parse(text) as T;
}

async function openTerminal(page: Page) {
  const workspaceResult = await postJson<{ ok: true; data: { workspace: { id: string } } }>('/api/workspaces/create', {
    cwd: resolve('.'),
    requestId: 'perf-workspace',
  });
  const workspaceId = workspaceResult.data.workspace.id;
  const tabResult = await postJson<{ ok: true; data: { tab: { id: string } } }>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/tabs/create`,
    { requestId: 'perf-tab' },
  );
  await page.goto(`${baseUrl}/terminal?workspace=${encodeURIComponent(workspaceId)}&tab=${encodeURIComponent(tabResult.data.tab.id)}`);
  await expect(page.getByTestId('terminal-composer-input')).toBeVisible();
}

test.beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'nterminal-perf-terminal-'));
  server = spawn(process.execPath, ['server.mjs'], {
    cwd: resolve('.'),
    env: { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDir },
  });
  await waitForReady();
});

test.afterAll(async () => {
  server?.kill();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const tempRoot = resolve(tmpdir());
  const resolvedDataDir = resolve(dataDir);
  if (resolvedDataDir.startsWith(tempRoot)) rmSync(resolvedDataDir, { recursive: true, force: true });
});

test('真实终端页 10KB 命令粘贴保持响应', async ({ page }) => {
  await openTerminal(page);
  const tenKb = 'x'.repeat(10 * 1024);
  const samples: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    samples.push(await page.evaluate(async (text) => {
      const input = document.querySelector('[data-testid="terminal-composer-input"]') as HTMLTextAreaElement;
      const started = performance.now();
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return performance.now() - started;
    }, tenKb));
  }
  const worst = Math.max(...samples);
  console.log(JSON.stringify({ metric: 'terminal_10kb_paste_ms', samples, worst }));
  expect(worst).toBeLessThanOrEqual(300);
});
