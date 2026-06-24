import { cpSync, mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDatabase, getDb, initializeDatabase, insertConversationSource } from '../../../server/database.mjs';
import { classifySourceError, createImportEngine } from '../../../server/conversation-import.mjs';

const piFixture = resolve(import.meta.dirname, '../../fixtures/pi/session.jsonl');
let tempDir;

afterEach(() => {
  closeDatabase();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe('来源错误隔离与恢复', () => {
  it.each([
    ['SQLITE_BUSY', 'SOURCE_LOCKED', true],
    ['SQLITE_LOCKED', 'SOURCE_LOCKED', true],
    ['EACCES', 'SOURCE_PERMISSION', false],
    ['EPERM', 'SOURCE_PERMISSION', false],
    ['SQLITE_FULL', 'SOURCE_DISK_FULL', false],
    ['SQLITE_ERROR', 'SOURCE_SCHEMA', false],
  ])('%s 映射为稳定错误契约', (nativeCode, expectedCode, retryable) => {
    const error = new Error('外部底层错误');
    error.code = nativeCode;
    expect(classifySourceError(error)).toMatchObject({ code: expectedCode, retryable });
  });

  it('坏文件保留旧数据，其他来源成功，修复后可重试清错', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'nterminal-source-errors-'));
    const goodDir = join(tempDir, 'good');
    const badDir = join(tempDir, 'bad');
    mkdirSync(goodDir);
    mkdirSync(badDir);
    cpSync(piFixture, join(goodDir, 'session.jsonl'));
    cpSync(piFixture, join(badDir, 'session.jsonl'));
    const badFile = join(badDir, 'broken.jsonl');
    // broken.jsonl 是合法 JSON 且首行能被识别为 pi 会话,
    // 但内部消息使用不支持的 role, 触发真正的解析错误, 应当让 source 标 error。
    writeFileSync(badFile, [
      JSON.stringify({ type: 'session', version: 3, id: 'broken', cwd: 'H:/fixture', timestamp: '2026-01-01T00:00:00.000Z' }),
      JSON.stringify({ type: 'message', message: { role: 'alien', content: 'bad' } }),
    ].join('\n'));
    initializeDatabase(join(tempDir, 'nterminal.db'));
    const good = insertConversationSource({ path: goodDir, agentType: 'pi' });
    const bad = insertConversationSource({ path: badDir, agentType: 'pi' });
    const db = getDb();
    db.prepare(`INSERT INTO conversations
      (id, source_id, role, content, user_text)
      VALUES ('keep-on-error', ?, 'user', '必须保留', '必须保留')`).run(bad.id);

    const engine = createImportEngine({ db });
    const results = await engine.syncAll();
    expect(results.find((item) => item.sourceId === good.id).state).toBe('active');
    expect(results.find((item) => item.sourceId === bad.id)).toMatchObject({
      state: 'error',
      error: { code: 'PARSE_ERROR', retryable: true },
    });
    expect(db.prepare('SELECT id FROM conversations WHERE source_id = ?').all(bad.id)).toEqual([{ id: 'keep-on-error' }]);
    expect(db.prepare('SELECT sync_state, last_error_code FROM conversation_sources WHERE id = ?').get(bad.id))
      .toEqual({ sync_state: 'error', last_error_code: 'PARSE_ERROR' });

    unlinkSync(badFile);
    const recovered = await engine.syncSource(bad.id);
    expect(recovered.state).toBe('active');
    expect(db.prepare('SELECT sync_state, last_error_code FROM conversation_sources WHERE id = ?').get(bad.id))
      .toEqual({ sync_state: 'active', last_error_code: null });
    engine.stop();
  });

  it('不存在的来源路径返回可重试结构化错误', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'nterminal-source-missing-'));
    initializeDatabase(join(tempDir, 'nterminal.db'));
    const source = insertConversationSource({ path: join(tempDir, 'missing'), agentType: 'codex' });
    const engine = createImportEngine({ db: getDb() });
    await expect(engine.syncSource(source.id)).resolves.toMatchObject({
      state: 'error',
      error: { code: 'SOURCE_MISSING', retryable: true },
    });
    engine.stop();
  });
});
