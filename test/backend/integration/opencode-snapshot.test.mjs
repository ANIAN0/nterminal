import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDatabase, getDb, initializeDatabase, insertConversationSource } from '../../../server/database.mjs';
import { createImportEngine } from '../../../server/conversation-import.mjs';
import { createOpenCodeFixture } from '../../fixtures/opencode/create-database.mjs';

let tempDir;
let activeWriter;
let activeTimer;

afterEach(() => {
  if (activeTimer) clearInterval(activeTimer);
  activeTimer = undefined;
  try { activeWriter?.close(); } catch { /* 测试已关闭时忽略 */ }
  activeWriter = undefined;
  closeDatabase();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function snapshotDirs() {
  return readdirSync(tmpdir()).filter((name) => name.startsWith('nterminal-opencode-')).sort();
}

describe('OpenCode 一致快照', () => {
  it('WAL 持续写入时同步无锁，保留目录并清理快照', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'nterminal-opencode-source-'));
    const sourcePath = join(tempDir, 'opencode.db');
    createOpenCodeFixture(sourcePath);
    const writer = new Database(sourcePath);
    activeWriter = writer;
    writer.pragma('journal_mode = WAL');
    const seedMessage = writer.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
    const seedPart = writer.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)');
    writer.transaction(() => {
      // 扩大源库，确保 online backup 运行期间事件循环有机会继续提交 WAL 写入。
      for (let index = 0; index < 10_000; index += 1) {
        const timestamp = 1_700_000_003_000 + index;
        seedMessage.run(`seed-message-${index}`, 'opencode-session', timestamp, timestamp, JSON.stringify({ role: 'user' }));
        seedPart.run(`seed-part-${index}`, `seed-message-${index}`, 'opencode-session', timestamp, JSON.stringify({ type: 'text', text: `seed ${index}` }));
      }
    })();
    initializeDatabase(join(tempDir, 'nterminal.db'));
    const source = insertConversationSource({ path: sourcePath, agentType: 'opencode' });
    const engine = createImportEngine({ db: getDb() });
    const beforeDirs = snapshotDirs();
    let writeIndex = 0;
    const timer = setInterval(() => {
      const index = ++writeIndex;
      const timestamp = 1_700_000_010_000 + index;
      writer.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)')
        .run(`live-message-${index}`, 'opencode-session', timestamp, timestamp, JSON.stringify({ role: 'user' }));
      writer.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)')
        .run(`live-part-${index}`, `live-message-${index}`, 'opencode-session', timestamp, JSON.stringify({ type: 'text', text: `live ${index}` }));
      if (index >= 40) {
        clearInterval(timer);
        activeTimer = undefined;
      }
    }, 2);
    activeTimer = timer;

    await new Promise((resolve) => setTimeout(resolve, 6));
    const writesBeforeBackup = writeIndex;
    let lastHeartbeat = performance.now();
    let maxHeartbeatDelay = 0;
    const heartbeat = setInterval(() => {
      const now = performance.now();
      maxHeartbeatDelay = Math.max(maxHeartbeatDelay, now - lastHeartbeat);
      lastHeartbeat = now;
    }, 10);

    const first = await engine.syncSource(source.id);
    clearInterval(heartbeat);
    clearInterval(timer);
    activeTimer = undefined;
    writer.close();
    activeWriter = undefined;

    expect(first.state).toBe('active');
    expect(first.inserted).toBeGreaterThanOrEqual(2);
    expect(writeIndex).toBeGreaterThan(writesBeforeBackup);
    expect(maxHeartbeatDelay).toBeLessThan(100);
    expect(getDb().prepare('SELECT cwd FROM conversation_sessions WHERE source_id = ?').get(source.id).cwd)
      .toBe('H:/fixture/opencode');
    expect(snapshotDirs()).toEqual(beforeDirs);

    const second = await engine.syncSource(source.id);
    expect(second.state).toBe('active');
    const countAfterCatchup = getDb().prepare('SELECT COUNT(*) AS count FROM conversations WHERE source_id = ?').get(source.id).count;
    expect(countAfterCatchup).toBeGreaterThanOrEqual(first.inserted);
    const third = await engine.syncSource(source.id);
    expect(third).toMatchObject({ state: 'active', inserted: 0, skipped: true });
    expect(getDb().prepare('SELECT sync_state FROM conversation_sources WHERE id = ?').get(source.id))
      .toEqual({ sync_state: 'active' });
    expect(snapshotDirs()).toEqual(beforeDirs);
    engine.stop();
  }, 60_000);

  it('schema 错误返回不可重试错误且不残留快照', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'nterminal-opencode-schema-'));
    const sourcePath = join(tempDir, 'opencode.db');
    new Database(sourcePath).close();
    initializeDatabase(join(tempDir, 'nterminal.db'));
    const source = insertConversationSource({ path: sourcePath, agentType: 'opencode' });
    const beforeDirs = snapshotDirs();
    const engine = createImportEngine({ db: getDb() });
    await expect(engine.syncSource(source.id)).resolves.toMatchObject({
      state: 'error',
      error: { code: 'SOURCE_SCHEMA', retryable: false },
    });
    expect(snapshotDirs()).toEqual(beforeDirs);
    engine.stop();
  });
});
