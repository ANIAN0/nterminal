import Database from 'better-sqlite3';

export function createOpenCodeFixture(dbPath) {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      directory TEXT,
      title TEXT,
      time_created INTEGER,
      time_updated INTEGER
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER,
      time_updated INTEGER,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT,
      time_created INTEGER,
      data TEXT NOT NULL
    );
  `);
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?)')
    .run('opencode-session', 'H:/fixture/opencode', 'OpenCode fixture', 1_700_000_000_000, 1_700_000_002_000);
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)')
    .run('opencode-message-1', 'opencode-session', 1_700_000_001_000, 1_700_000_001_000, JSON.stringify({ role: 'user' }));
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)')
    .run('opencode-message-2', 'opencode-session', 1_700_000_002_000, 1_700_000_002_000, JSON.stringify({ role: 'assistant' }));
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)')
    .run('part-1', 'opencode-message-1', 'opencode-session', 1_700_000_001_000, JSON.stringify({ type: 'text', text: '检查 OpenCode' }));
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)')
    .run('part-2', 'opencode-message-2', 'opencode-session', 1_700_000_002_000, JSON.stringify({ type: 'text', text: 'OpenCode 正常' }));
  db.close();
}
