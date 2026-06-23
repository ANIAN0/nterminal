import { test, expect, type Page } from 'playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';

let server: ChildProcessWithoutNullStreams | null = null;
let dataDir = '';
const root = resolve('.');
const port = 3230;
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

function seedHistory() {
  const db = new Database(join(dataDir, 'nterminal.db'));
  try {
    db.prepare(`
      INSERT INTO conversation_sources
        (id, path, agent_type, label, status, sync_state, record_count, last_success_at)
      VALUES
        ('release-source', 'H:/release/source', 'codex', 'Release Source', 'active', 'active', 2, '2026-06-23T09:00:00.000Z')
    `).run();
    db.prepare(`
      INSERT INTO conversation_sessions
        (session_key, source_id, native_session_id, cwd, title, started_at, ended_at, source_file, message_count)
      VALUES
        ('release-source:main', 'release-source', 'release-native-session', 'H:/release/workspace', 'Release main flow', '2026-06-23T09:00:00.000Z', '2026-06-23T09:02:00.000Z', 'release.jsonl', 2)
    `).run();
    db.prepare(`
      INSERT INTO conversations
        (id, source_id, session_id, session_key, native_message_id, message_index, role,
         content, tool_calls, tool_call_id, metadata, user_text, ended_at, cwd, source_file)
      VALUES
        ('release-msg-0', 'release-source', 'main', 'release-source:main', 'm0', 0, 'user', 'release searchable message', NULL, NULL, NULL, 'release searchable message', '2026-06-23T09:00:00.000Z', 'H:/release/workspace', 'release.jsonl'),
        ('release-msg-1', 'release-source', 'main', 'release-source:main', 'm1', 1, 'assistant', 'release assistant answer', '{"name":"read"}', 'tool-1', '{"ok":true}', NULL, '2026-06-23T09:01:00.000Z', 'H:/release/workspace', 'release.jsonl')
    `).run();
  } finally {
    db.close();
  }
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
  dataDir = makeTempDir('nterminal-product-main-');
  server = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDir },
  });
  await waitForHealth();
  seedHistory();
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

test('发布主流程覆盖概览、终端、历史、详情、设置和 health', async ({ page, request }) => {
  const consoleErrors = collectConsoleErrors(page);
  const health = await request.get(`${baseUrl}/api/health`);
  await expect(health).toBeOK();
  await expect(await health.json()).toMatchObject({ ok: true, data: { status: 'ready', version: '1.3' } });

  await page.goto(baseUrl);
  await expect(page.getByTestId('workspace-sidebar')).toBeVisible();

  await page.goto(`${baseUrl}/settings`);
  await expect(page.getByTestId('source-path')).toBeVisible();

  await page.goto(`${baseUrl}/history`);
  await expect(page.getByText('Release Source')).toBeVisible();
  await page.getByPlaceholder(/搜索|Search/i).fill('release searchable');
  await page.getByRole('button', { name: /搜索|Search/i }).click();
  await expect(page.getByRole('link', { name: /Release main flow/ })).toBeVisible();
  await page.getByRole('link', { name: /Release main flow/ }).click();
  await expect(page.getByText('release-native-session')).toBeVisible();
  await expect(page.getByText('{"name":"read"}')).toBeVisible();

  const workspaceResult = await postJson<{ ok: true; data: { workspace: { id: string } } }>('/api/workspaces/create', {
    cwd: root,
    requestId: 'release-main-workspace',
  });
  const tabResult = await postJson<{ ok: true; data: { tab: { id: string } } }>(
    `/api/workspaces/${encodeURIComponent(workspaceResult.data.workspace.id)}/tabs/create`,
    { requestId: 'release-main-tab' },
  );
  await page.goto(`${baseUrl}/terminal?workspace=${encodeURIComponent(workspaceResult.data.workspace.id)}&tab=${encodeURIComponent(tabResult.data.tab.id)}`);
  await expect(page.getByTestId('workspace-sidebar')).toBeVisible();
  await expect(page.getByTestId('tab-create')).toBeEnabled();
  const input = page.getByTestId('terminal-composer-input');
  await expect(input).toBeVisible();
  await input.fill('echo release-main-flow');
  await input.press('Enter');
  await expect(input).toHaveValue('');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: 'test-results/product-main-1440x900.png', fullPage: true });
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.screenshot({ path: 'test-results/product-main-1024x768.png', fullPage: true });

  expect(consoleErrors).toEqual([]);
});
