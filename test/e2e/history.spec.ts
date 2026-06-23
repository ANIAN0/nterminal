import { test, expect } from 'playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';

let server: ChildProcessWithoutNullStreams | null = null;
let dataDir = '';
const port = 3222;
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
    await new Promise((resolveReady) => setTimeout(resolveReady, 200));
  }
  throw new Error('server_not_ready');
}

function seedHistory() {
  const db = new Database(join(dataDir, 'nterminal.db'));
  try {
    const codex = 'e2e-codex';
    const claude = 'e2e-claude';
    db.prepare(`
      INSERT INTO conversation_sources
        (id, path, agent_type, label, status, sync_state, record_count)
      VALUES
        (?, 'H:/e2e/codex', 'codex', 'Codex E2E', 'active', 'active', 2),
        (?, 'H:/e2e/claude', 'claude', 'Claude E2E', 'error', 'error', 1)
    `).run(codex, claude);
    db.prepare(`
      UPDATE conversation_sources
      SET last_error_code = 'SOURCE_MISSING', last_error_message = '来源目录不存在'
      WHERE id = ?
    `).run(claude);
    db.prepare(`
      INSERT INTO conversation_sessions
        (session_key, source_id, native_session_id, cwd, title, started_at, ended_at, source_file, message_count)
      VALUES
        (?, ?, 'codex-session', 'H:/workspace/app', '修复历史分组', '2026-06-23T09:00:00.000Z', '2026-06-23T09:03:00.000Z', 'codex.jsonl', 2),
        (?, ?, 'claude-session', NULL, '错误来源会话', '2026-06-23T10:00:00.000Z', '2026-06-23T10:02:00.000Z', 'claude.jsonl', 1)
    `).run(`${codex}:codex-session`, codex, `${claude}:claude-session`, claude);
    db.prepare(`
      INSERT INTO conversations
        (id, source_id, session_id, session_key, native_message_id, message_index, role,
         content, tool_calls, tool_call_id, metadata, user_text, ended_at, cwd, source_file)
      VALUES
        ('e2e-codex-0', ?, 'codex-session', ?, 'm0', 0, 'user', '请修复历史分组', NULL, NULL, NULL, '请修复历史分组', '2026-06-23T09:00:00.000Z', 'H:/workspace/app', 'codex.jsonl'),
        ('e2e-codex-1', ?, 'codex-session', ?, 'm1', 1, 'assistant', '已检查工具', '{"name":"read"}', 'tool-1', '{"phase":"analysis"}', NULL, '2026-06-23T09:01:00.000Z', 'H:/workspace/app', 'codex.jsonl'),
        ('e2e-claude-0', ?, 'claude-session', ?, 'm0', 0, 'user', '错误来源旧数据', NULL, NULL, NULL, '错误来源旧数据', '2026-06-23T10:00:00.000Z', NULL, 'claude.jsonl')
    `).run(codex, `${codex}:codex-session`, codex, `${codex}:codex-session`, claude, `${claude}:claude-session`);
  } finally {
    db.close();
  }
}

test.beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'nterminal-e2e-history-'));
  server = spawn(process.execPath, ['server.mjs'], {
    cwd: resolve('.'),
    env: { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDir },
  });
  await waitForReady();
  seedHistory();
});

test.afterAll(async () => {
  server?.kill();
  await new Promise((resolveDone) => setTimeout(resolveDone, 500));
  const tempRoot = resolve(tmpdir());
  const resolvedDataDir = resolve(dataDir);
  if (resolvedDataDir.startsWith(tempRoot)) rmSync(resolvedDataDir, { recursive: true, force: true });
});

test('历史页按来源、工作区和会话展示，并可进入完整详情', async ({ page }) => {
  await page.goto(`${baseUrl}/history`);

  await expect(page.getByText('Codex E2E')).toBeVisible();
  await expect(page.getByText('H:/workspace/app')).toBeVisible();
  await expect(page.getByRole('link', { name: /修复历史分组/ })).toBeVisible();
  await expect(page.getByText('来源目录不存在')).toBeVisible();

  await page.getByPlaceholder('搜索会话、消息或工具内容').fill('历史分组');
  await page.getByRole('button', { name: '搜索' }).click();
  await expect(page.getByRole('link', { name: /修复历史分组/ })).toBeVisible();

  await page.getByRole('link', { name: /修复历史分组/ }).click();
  await expect(page).toHaveURL(/\/history\/detail\?sourceId=e2e-codex&sessionKey=e2e-codex%3Acodex-session/);
  await expect(page.getByText('codex-session')).toBeVisible();
  await expect(page.getByText('H:/workspace/app')).toBeVisible();
  await expect(page.getByText('{"name":"read"}')).toBeVisible();
  await expect(page.getByRole('button', { name: /删除/ })).toHaveCount(0);
});

test('旧单消息 records API 不再暴露', async ({ request }) => {
  const detail = await request.post(`${baseUrl}/api/records/detail`, { data: { recordId: 'e2e-codex-0' } });
  const remove = await request.post(`${baseUrl}/api/records/delete`, { data: { recordId: 'e2e-codex-0' } });

  expect(detail.status()).toBe(404);
  expect(remove.status()).toBe(404);
});
