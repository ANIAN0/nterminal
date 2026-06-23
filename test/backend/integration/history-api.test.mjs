import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDatabase, getDb, initializeDatabase, insertConversationSource } from '../../../server/database.mjs';
import { getHistorySession, listHistorySessions } from '../../../server/history-service.mjs';

let tempDir;

afterEach(() => {
  closeDatabase();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function createFixture() {
  tempDir = mkdtempSync(join(tmpdir(), 'nterminal-history-api-'));
  initializeDatabase(join(tempDir, 'nterminal.db'));
  const db = getDb();
  const codex = insertConversationSource({ path: 'H:/workspace/codex-source', agentType: 'codex', label: 'Codex' });
  const claude = insertConversationSource({ path: 'H:/workspace/claude-source', agentType: 'claude', label: 'Claude' });
  db.prepare(`
    UPDATE conversation_sources
    SET status = 'error', sync_state = 'error', last_error_code = 'SOURCE_MISSING',
        last_error_message = '来源目录不存在', last_error_at = '2026-06-23T08:00:00.000Z'
    WHERE id = ?
  `).run(claude.id);

  const insertSession = db.prepare(`
    INSERT INTO conversation_sessions
      (session_key, source_id, native_session_id, cwd, title, started_at, ended_at, source_file, message_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMessage = db.prepare(`
    INSERT INTO conversations
      (id, source_id, session_id, session_key, native_message_id, message_index, role,
       content, tool_calls, tool_call_id, metadata, user_text, ended_at, cwd, source_file)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertSession.run(`${codex.id}:native-a`, codex.id, 'native-a', 'H:/workspace/app', '修复终端输入', '2026-06-23T09:00:00.000Z', '2026-06-23T09:03:00.000Z', 'codex-a.jsonl', 3);
  insertMessage.run('codex-a-0', codex.id, 'native-a', `${codex.id}:native-a`, 'm0', 0, 'user', '请修复终端输入', null, null, '{"kind":"prompt"}', '请修复终端输入', '2026-06-23T09:00:00.000Z', 'H:/workspace/app', 'codex-a.jsonl');
  insertMessage.run('codex-a-1', codex.id, 'native-a', `${codex.id}:native-a`, 'm1', 1, 'assistant', '我会检查 Warp 风格输入框', '{"name":"read"}', 'tool-1', '{"phase":"analysis"}', null, '2026-06-23T09:01:00.000Z', 'H:/workspace/app', 'codex-a.jsonl');
  insertMessage.run('codex-a-2', codex.id, 'native-a', `${codex.id}:native-a`, 'm2', 2, 'tool', '{"ok":true}', null, 'tool-1', '{"duration":12}', null, '2026-06-23T09:02:00.000Z', 'H:/workspace/app', 'codex-a.jsonl');

  insertSession.run(`${claude.id}:native-b`, claude.id, 'native-b', null, '历史错误来源仍可读', '2026-06-23T10:00:00.000Z', '2026-06-23T10:02:00.000Z', 'claude-b.jsonl', 1);
  insertMessage.run('claude-b-0', claude.id, 'native-b', `${claude.id}:native-b`, 'm0', 0, 'user', '短查询 A', null, null, null, '短查询 A', '2026-06-23T10:00:00.000Z', null, 'claude-b.jsonl');

  return { codex, claude };
}

describe('会话级历史 API', () => {
  it('按来源、工作区和会话分组，并保留 partial 来源状态', () => {
    const { codex, claude } = createFixture();

    const result = listHistorySessions({ query: '*', limit: 20 });

    expect(result.sourceStates).toEqual([
      expect.objectContaining({ sourceId: codex.id, agentType: 'codex', label: 'Codex', state: 'active' }),
      expect.objectContaining({ sourceId: claude.id, agentType: 'claude', label: 'Claude', state: 'error', errorCode: 'SOURCE_MISSING', errorMessage: '来源目录不存在' }),
    ]);
    expect(result.groups).toEqual([
      expect.objectContaining({
        sourceId: claude.id,
        workspaces: [
          expect.objectContaining({
            cwd: 'H:/workspace/claude-source',
            sessions: [expect.objectContaining({ sessionKey: `${claude.id}:native-b`, nativeSessionId: 'native-b', messageCount: 1 })],
          }),
        ],
      }),
      expect.objectContaining({
        sourceId: codex.id,
        workspaces: [
          expect.objectContaining({
            cwd: 'H:/workspace/app',
            sessions: [expect.objectContaining({ sessionKey: `${codex.id}:native-a`, nativeSessionId: 'native-a', title: '修复终端输入' })],
          }),
        ],
      }),
    ]);
  });

  it('返回完整会话详情，目录、会话和工具元数据不为空且按 message_index 排序', () => {
    const { codex } = createFixture();

    const result = getHistorySession({ sourceId: codex.id, sessionKey: `${codex.id}:native-a` });

    expect(result.session).toMatchObject({
      sourceId: codex.id,
      sessionKey: `${codex.id}:native-a`,
      nativeSessionId: 'native-a',
      cwd: 'H:/workspace/app',
      title: '修复终端输入',
    });
    expect(result.messages.map((message) => [message.messageIndex, message.role, message.content])).toEqual([
      [0, 'user', '请修复终端输入'],
      [1, 'assistant', '我会检查 Warp 风格输入框'],
      [2, 'tool', '{"ok":true}'],
    ]);
    expect(result.messages[1]).toMatchObject({ toolCalls: '{"name":"read"}', toolCallId: 'tool-1', metadata: '{"phase":"analysis"}' });
    expect(result.messages[2]).toMatchObject({ toolCallId: 'tool-1', metadata: '{"duration":12}' });
  });

  it('不存在的会话返回稳定错误码', () => {
    const { codex } = createFixture();

    expect(() => getHistorySession({ sourceId: codex.id, sessionKey: `${codex.id}:missing` })).toThrow(/history_session_not_found/);
  });
});
