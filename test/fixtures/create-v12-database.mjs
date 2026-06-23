import Database from 'better-sqlite3';

export function createV12Database(dbPath) {
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE conversation_sources (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      agent_type TEXT NOT NULL CHECK(agent_type IN ('claude', 'pi', 'codex', 'opencode')),
      label TEXT,
      metadata TEXT,
      last_synced_at TEXT,
      record_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'paused', 'error')),
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      source_id TEXT,
      session_id TEXT,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
      content TEXT,
      tool_calls TEXT,
      tool_call_id TEXT,
      metadata TEXT,
      user_text TEXT,
      ended_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      cwd TEXT,
      FOREIGN KEY(source_id) REFERENCES conversation_sources(id) ON DELETE SET NULL
    );
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      last_active_at TEXT,
      session_count INTEGER DEFAULT 0
    );
    CREATE TABLE tab_sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      pty_status TEXT CHECK (pty_status IN ('running','ended','error')),
      created_at TEXT,
      killed_at TEXT,
      last_ws_seen_at TEXT,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
    );
  `);

  db.prepare(`INSERT INTO conversation_sources
    (id, path, agent_type, label, record_count, status)
    VALUES ('source-1', 'fixture', 'codex', 'fixture', 2, 'active')`).run();
  const insert = db.prepare(`INSERT INTO conversations
    (id, source_id, session_id, role, content, user_text, ended_at, cwd)
    VALUES (?, 'source-1', NULL, ?, ?, ?, ?, NULL)`);
  insert.run('message-1', 'user', '终端输入修复', '终端输入修复', '2026-01-01T00:00:00.000Z');
  insert.run('message-2', 'assistant', '完成', null, '2026-01-01T00:00:01.000Z');
  db.prepare("INSERT INTO workspaces (id, display_name) VALUES ('H:/fixture', 'fixture')").run();
  db.prepare("INSERT INTO tab_sessions (id, workspace_id, pty_status, created_at) VALUES ('tab-1', 'H:/fixture', 'ended', '2026-01-01T00:00:00.000Z')").run();
  db.close();
}
