import { test, expect, type Page } from 'playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';

let server: ChildProcessWithoutNullStreams | null = null;
let dataDir = '';
const port = 3220;
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
      // 服务启动期间连接失败是预期状态。
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
    requestId: 'e2e-workspace',
  });
  const workspaceId = workspaceResult.data.workspace.id;
  const tabResult = await postJson<{ ok: true; data: { tab: { id: string } } }>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/tabs/create`,
    { requestId: 'e2e-tab' },
  );
  const tabId = tabResult.data.tab.id;
  await page.goto(`${baseUrl}/terminal?workspace=${encodeURIComponent(workspaceId)}&tab=${encodeURIComponent(tabId)}`);
  await expect(page.getByTestId('terminal-composer-input')).toBeVisible();
}

test.beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'nterminal-e2e-terminal-'));
  server = spawn(process.execPath, ['server.mjs'], {
    cwd: resolve('.'),
    env: { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDir },
  });
  await waitForReady();
  const db = new Database(join(dataDir, 'nterminal.db'));
  try {
    db.prepare(`
      INSERT INTO conversations (id, role, content, user_text, ended_at)
      VALUES ('e2e-completion-seed', 'user', 'npm test', 'npm test', datetime('now'))
    `).run();
  } finally {
    db.close();
  }
});

test.afterAll(async () => {
  server?.kill();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const tempRoot = resolve(tmpdir());
  const resolvedDataDir = resolve(dataDir);
  if (resolvedDataDir.startsWith(tempRoot)) rmSync(resolvedDataDir, { recursive: true, force: true });
});

test('终端输入器固定底部、提交清空且不再显示旧面板', async ({ page }) => {
  await openTerminal(page);

  const composer = page.getByTestId('terminal-composer');
  const input = page.getByTestId('terminal-composer-input');
  const terminal = page.locator('.poc-terminal');
  await expect(page.getByTestId('input-buffer')).toHaveCount(0);
  await expect(page.getByTestId('search-results')).toHaveCount(0);

  const composerBox = await composer.boundingBox();
  const terminalBox = await terminal.boundingBox();
  expect(composerBox && terminalBox && composerBox.y > terminalBox.y).toBeTruthy();
  expect(composerBox && composerBox.y + composerBox.height <= page.viewportSize()!.height).toBeTruthy();

  await input.fill('echo 1');
  await input.press('Enter');
  await expect(input).toHaveValue('');
});

test('窄视口下 composer 仍留在可视底部且只有一个建议面板', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openTerminal(page);
  const input = page.getByTestId('terminal-composer-input');
  await input.fill('np');
  await expect(page.getByTestId('completion-panel')).toHaveCount(1);
  const box = await page.getByTestId('terminal-composer').boundingBox();
  expect(box && box.y + box.height <= 768).toBeTruthy();
});
