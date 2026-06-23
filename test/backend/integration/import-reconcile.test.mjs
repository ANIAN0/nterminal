import { cpSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDatabase, getDb, initializeDatabase, insertConversationSource } from '../../../server/database.mjs';
import { createImportEngine } from '../../../server/conversation-import.mjs';

const piFixture = resolve(import.meta.dirname, '../../fixtures/pi/session.jsonl');
let tempDir;

afterEach(() => {
  closeDatabase();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe('来源首次 reconcile', () => {
  it('并发请求合并，原子替换旧空归属，重复同步不增加消息', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'nterminal-reconcile-'));
    const sourceDir = join(tempDir, 'source');
    mkdirSync(sourceDir);
    cpSync(piFixture, join(sourceDir, 'session.jsonl'));
    initializeDatabase(join(tempDir, 'nterminal.db'));
    const source = insertConversationSource({ path: sourceDir, agentType: 'pi' });
    const db = getDb();
    db.prepare(`INSERT INTO conversations
      (id, source_id, session_id, role, content, user_text)
      VALUES ('legacy-empty', ?, NULL, 'user', '旧空归属', '旧空归属')`).run(source.id);

    const engine = createImportEngine({ db });
    const [first, duplicate] = await Promise.all([
      engine.syncSource(source.id),
      engine.syncSource(source.id),
    ]);

    expect(duplicate).toBe(first);
    expect(first).toMatchObject({ sourceId: source.id, state: 'active', inserted: 2, failedFiles: [] });
    expect(db.prepare('SELECT COUNT(*) AS count FROM conversations WHERE source_id = ?').get(source.id).count).toBe(2);
    expect(db.prepare('SELECT COUNT(*) AS count FROM conversation_sessions WHERE source_id = ?').get(source.id).count).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS count FROM conversations WHERE id = ?').get('legacy-empty').count).toBe(0);
    expect(db.prepare('SELECT session_key, cwd, source_file, message_index FROM conversations WHERE source_id = ? ORDER BY message_index').all(source.id))
      .toEqual([
        expect.objectContaining({ session_key: `${source.id}:pi:pi-session`, cwd: 'H:/fixture/pi', source_file: join(sourceDir, 'session.jsonl'), message_index: 0 }),
        expect.objectContaining({ session_key: `${source.id}:pi:pi-session`, cwd: 'H:/fixture/pi', source_file: join(sourceDir, 'session.jsonl'), message_index: 1 }),
      ]);
    expect(db.prepare('SELECT needs_reconcile, sync_state, last_error_code FROM conversation_sources WHERE id = ?').get(source.id))
      .toEqual({ needs_reconcile: 0, sync_state: 'active', last_error_code: null });

    const second = await engine.syncSource(source.id);
    expect(second).toMatchObject({ state: 'active', inserted: 2 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM conversations WHERE source_id = ?').get(source.id).count).toBe(2);
    engine.stop();
  });
});
