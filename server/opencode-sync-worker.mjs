/**
 * OpenCode 同步 worker 入口。
 * 通过 sqlite-snapshot 在 tmpdir 创建只读快照后再解析 + 替换写入，
 * 避免对运行中的 OpenCode 数据库加锁；按 revision 决定是否跳过本次同步。
 */

import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { parseSourceFile } from './conversation-parser.mjs';
import { readOpenCodeRevision } from './parsers/opencode-parser.mjs';
import { withSqliteSnapshot } from './sqlite-snapshot.mjs';

// replaceSource：按 sourceId 原子替换已有会话与消息，并刷新源状态列。
function replaceSource(db, sourceId, sourcePath, sessions, revision) {
  return db.transaction(() => {
    const before = db.prepare('SELECT COUNT(*) AS count FROM conversations WHERE source_id = ?').get(sourceId).count;
    db.prepare('DELETE FROM conversations WHERE source_id = ?').run(sourceId);
    db.prepare('DELETE FROM conversation_sessions WHERE source_id = ?').run(sourceId);
    const insertSession = db.prepare(`
      INSERT INTO conversation_sessions
        (session_key, source_id, native_session_id, cwd, title, started_at, ended_at,
         source_file, message_count, metadata, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, datetime('now'))
    `);
    const insertMessage = db.prepare(`
      INSERT INTO conversations
        (id, source_id, session_id, session_key, native_message_id, message_index, role,
         content, tool_calls, tool_call_id, metadata, user_text, ended_at, cwd, source_file)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let inserted = 0;
    for (const session of sessions) {
      const sessionKey = `${sourceId}:${session.sessionKey}`;
      insertSession.run(sessionKey, sourceId, session.nativeSessionId, session.cwd, session.title,
        session.startedAt, session.endedAt, sourcePath, session.messages.length);
      for (const message of session.messages) {
        insertMessage.run(`${sourceId}:${message.nativeMessageId}`, sourceId, session.nativeSessionId,
          sessionKey, message.nativeMessageId, message.messageIndex, message.role, message.content,
          message.toolCalls, message.toolCallId, message.metadata,
          message.role === 'user' ? message.content : null, message.timestamp, session.cwd, sourcePath);
        inserted += 1;
      }
    }
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE conversation_sources SET status='active', sync_state='active', needs_reconcile=0,
        record_count=?, last_synced_at=?, last_success_at=?, metadata=?,
        last_error_code=NULL, last_error_message=NULL, last_error_at=NULL
      WHERE id=?
    `).run(inserted, now, now, JSON.stringify({ lastMessageTime: revision }), sourceId);
    return { inserted, deleted: before, lastSuccessAt: now };
  })();
}

// execute：opencode 同步主流程；通过 withSqliteSnapshot 拿只读快照后再做解析与替换写入。
async function execute() {
  const { sourcePath, targetDbPath, sourceId, needsReconcile, previousRevision } = workerData;
  return withSqliteSnapshot(sourcePath, (snapshotPath) => {
    const revision = readOpenCodeRevision(snapshotPath);
    if (!needsReconcile && previousRevision && revision === previousRevision) {
      return { inserted: 0, deleted: 0, skipped: true, revision };
    }
    // 解析和大量 FTS 写入都留在 worker，主线程只接收小型统计结果。
    const sessions = parseSourceFile(snapshotPath, 'opencode');
    const db = new Database(targetDbPath);
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      db.pragma('busy_timeout = 5000');
      return { ...replaceSource(db, sourceId, sourcePath, sessions, revision), skipped: false, revision };
    } finally {
      db.close();
    }
  });
}

execute()
  .then((result) => parentPort.postMessage({ ok: true, result }))
  .catch((error) => parentPort.postMessage({
    ok: false,
    error: { code: error?.code || 'PARSE_ERROR', message: error instanceof Error ? error.message : String(error) },
  }));
