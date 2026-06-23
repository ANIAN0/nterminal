import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDatabase, getDb, initializeDatabase, insertConversationSource } from '../../../server/database.mjs';
import { listHistorySessions } from '../../../server/history-service.mjs';

let tempDir;

afterEach(() => {
  closeDatabase();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function seedSearchFixture() {
  tempDir = mkdtempSync(join(tmpdir(), 'nterminal-history-search-'));
  initializeDatabase(join(tempDir, 'nterminal.db'));
  const db = getDb();
  const source = insertConversationSource({ path: 'H:/workspace/source', agentType: 'codex', label: 'Codex' });
  const insertSession = db.prepare(`
    INSERT INTO conversation_sessions
      (session_key, source_id, native_session_id, cwd, title, started_at, ended_at, source_file, message_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMessage = db.prepare(`
    INSERT INTO conversations
      (id, source_id, session_id, session_key, native_message_id, message_index, role, content, user_text, ended_at, cwd, source_file)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (let index = 0; index < 8; index += 1) {
    const key = `${source.id}:s-${index}`;
    const content = index % 2 === 0 ? `终端输入历史 ${index}` : `短 A 历史 ${index}`;
    insertSession.run(key, source.id, `s-${index}`, 'H:/workspace/app', `会话 ${index}`, `2026-06-23T09:0${index}:00.000Z`, `2026-06-23T09:0${index}:30.000Z`, `s-${index}.jsonl`, 1);
    insertMessage.run(`m-${index}`, source.id, `s-${index}`, key, `m-${index}`, 0, 'user', content, content, `2026-06-23T09:0${index}:00.000Z`, 'H:/workspace/app', `s-${index}.jsonl`);
  }

  return { source };
}

describe('会话级历史搜索', () => {
  it('1-2 字符走有界 LIKE，3+ 字符走 FTS，并按会话分页稳定返回', () => {
    const { source } = seedSearchFixture();

    const short = listHistorySessions({ query: 'A', limit: 2 });
    expect(short.pagination.searchMode).toBe('like');
    expect(short.pagination.hasMore).toBe(true);
    expect(short.groups[0].workspaces[0].sessions).toHaveLength(2);
    expect(short.groups[0].workspaces[0].sessions.every((session) => session.snippet?.includes('A'))).toBe(true);

    const long = listHistorySessions({ query: '终端输入', limit: 10 });
    expect(long.pagination.searchMode).toBe('fts');
    expect(long.groups[0].sourceId).toBe(source.id);
    expect(long.groups[0].workspaces[0].sessions).toHaveLength(4);

    const plan = getDb().prepare(`
      EXPLAIN QUERY PLAN
      SELECT c.id FROM conversations_fts
      JOIN conversations c ON c.rowid = conversations_fts.rowid
      WHERE conversations_fts MATCH ?
    `).all('"终端输入"');
    expect(plan.some((row) => String(row.detail).includes('VIRTUAL TABLE INDEX'))).toBe(true);
  });

  it('特殊 LIKE 字符按字面量匹配，不扩大搜索范围', () => {
    const { source } = seedSearchFixture();
    const db = getDb();
    db.prepare(`
      INSERT INTO conversation_sessions
        (session_key, source_id, native_session_id, cwd, title, started_at, ended_at, source_file, message_count)
      VALUES (?, ?, 'literal', 'H:/workspace/app', '字面量', '2026-06-23T10:00:00.000Z', '2026-06-23T10:00:30.000Z', 'literal.jsonl', 1)
    `).run(`${source.id}:literal`, source.id);
    db.prepare(`
      INSERT INTO conversations
        (id, source_id, session_id, session_key, native_message_id, message_index, role, content, user_text, ended_at, cwd, source_file)
      VALUES ('literal-message', ?, 'literal', ?, 'literal-message', 0, 'user', '字面量 %_''', '字面量 %_''', '2026-06-23T10:00:00.000Z', 'H:/workspace/app', 'literal.jsonl')
    `).run(source.id, `${source.id}:literal`);

    const result = listHistorySessions({ query: "%_'", limit: 10 });

    expect(result.pagination.searchMode).toBe('fts');
    expect(result.groups.flatMap((group) => group.workspaces.flatMap((workspace) => workspace.sessions.map((session) => session.sessionKey))))
      .toEqual([`${source.id}:literal`]);
  });
});
