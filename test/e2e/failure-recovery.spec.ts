import { test, expect, type Page } from 'playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

let server: ChildProcessWithoutNullStreams | null = null;
let dataDir = '';
const root = resolve('.');
const port = 3231;
const baseUrl = `http://127.0.0.1:${port}`;

function makeTempDir(prefix: string) {
  const tmpRoot = join(root, 'test-results', 'tmp');
  mkdirSync(tmpRoot, { recursive: true });
  return mkdtempSync(join(tmpRoot, prefix));
}

async function waitForHealth() {
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      await new Promise((resolveReady) => setTimeout(resolveReady, 200));
    }
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

function collectConsoleErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

test.beforeAll(async () => {
  dataDir = makeTempDir('nterminal-failure-recovery-');
  server = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDir },
  });
  await waitForHealth();
});

test.afterAll(async () => {
  if (server && !server.killed) {
    await new Promise((resolveDone) => {
      server?.once('exit', resolveDone);
      server?.kill();
      setTimeout(resolveDone, 5000);
    });
  }
  if (dataDir.startsWith(join(root, 'test-results', 'tmp'))) rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('失败恢复覆盖 health 方法错误、来源错误重试和关闭最后标签返回概览', async ({ page, request }) => {
  const consoleErrors = collectConsoleErrors(page);
  const wrongMethod = await request.post(`${baseUrl}/api/health`, { data: {} });
  expect(wrongMethod.status()).toBe(405);

  const missingPath = join(dataDir, 'missing-opencode.db');
  const addSource = await request.post(`${baseUrl}/api/conversation-sources`, {
    data: { path: missingPath, agentType: 'opencode', label: 'Broken OpenCode' },
  });
  await expect(addSource).toBeOK();
  const sourceId = (await addSource.json()).data.id;
  const sync = await request.post(`${baseUrl}/api/conversation-sources/${sourceId}/sync`, { data: {} });
  await expect(sync).toBeOK();

  await page.goto(`${baseUrl}/settings`);
  await expect(page.getByText('Broken OpenCode')).toBeVisible();
  await expect(page.getByText(/SOURCE_/)).toBeVisible();
  const retry = page.getByTestId(`sync-source-${sourceId}`);
  await expect(retry).toContainText('重试');
  await page.route(`**/api/conversation-sources/${sourceId}/sync`, async (route) => {
    // 后端失败返回很快；这里只延迟网络转发，用真实后端响应稳定验证 UI 防重复点击。
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    await route.continue();
  });
  await retry.click();
  await expect(retry).toBeDisabled();
  await expect(retry).toBeEnabled({ timeout: 15000 });
  await page.unroute(`**/api/conversation-sources/${sourceId}/sync`);

  const workspaceResult = await postJson<{ ok: true; data: { workspace: { id: string } } }>('/api/workspaces/create', {
    cwd: root,
    requestId: 'failure-workspace',
  });
  const tabResult = await postJson<{ ok: true; data: { tab: { id: string } } }>(
    `/api/workspaces/${encodeURIComponent(workspaceResult.data.workspace.id)}/tabs/create`,
    { requestId: 'failure-tab' },
  );
  await page.goto(`${baseUrl}/terminal?workspace=${encodeURIComponent(workspaceResult.data.workspace.id)}&tab=${encodeURIComponent(tabResult.data.tab.id)}`);
  await expect(page.getByTestId('terminal-composer-input')).toBeVisible();
  await page.getByTestId(`tab-close-${tabResult.data.tab.id}`).click();
  await expect(page).toHaveURL(baseUrl + '/');

  expect(consoleErrors).toEqual([]);
});
