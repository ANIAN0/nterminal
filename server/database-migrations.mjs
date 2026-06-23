/**
 * nterminal 1.3 数据库迁移器。
 * 负责 schema_migrations 版本管理、对话来源/会话/消息/工作区/标签表的创建与升级，
 * 以及全文索引 FTS5 的重建。SQLite 重建表时不允许在事务内切换外键，因此迁移期
 * 会临时关闭 foreign_keys，迁移完成后再恢复。
 */

// DATABASE_SCHEMA_VERSION：当前 schema 版本号，每次不兼容变更需要自增并补对应迁移。
export const DATABASE_SCHEMA_VERSION = 13;

// tableExists：判断目标表是否已存在，用于幂等地创建或升级。
function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

// columns：读取表当前的列名集合，供 addColumn 判断是否需要补列。
function columns(db, table) {
  if (!tableExists(db, table)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

// addColumn：按 definition 补一列；列已存在时跳过，避免重复 ALTER 报错。
function addColumn(db, table, definition) {
  const name = definition.trim().split(/\s+/, 1)[0];
  if (!columns(db, table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

// createConversationSources：建对话源表，并幂等补齐 1.3 新增列（sync_state、needs_reconcile、错误字段等）。
function createConversationSources(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_sources (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      agent_type TEXT NOT NULL CHECK(agent_type IN ('claude', 'pi', 'codex', 'opencode')),
      label TEXT,
      metadata TEXT,
      last_synced_at TEXT,
      record_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'paused', 'error')),
      enabled INTEGER NOT NULL DEFAULT 1,
      sync_state TEXT NOT NULL DEFAULT 'idle',
      needs_reconcile INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      last_success_at TEXT,
      last_error_code TEXT,
      last_error_message TEXT,
      last_error_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  addColumn(db, 'conversation_sources', 'enabled INTEGER NOT NULL DEFAULT 1');
  addColumn(db, 'conversation_sources', "sync_state TEXT NOT NULL DEFAULT 'idle'");
  addColumn(db, 'conversation_sources', 'needs_reconcile INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'conversation_sources', 'last_attempt_at TEXT');
  addColumn(db, 'conversation_sources', 'last_success_at TEXT');
  addColumn(db, 'conversation_sources', 'last_error_code TEXT');
  addColumn(db, 'conversation_sources', 'last_error_message TEXT');
  addColumn(db, 'conversation_sources', 'last_error_at TEXT');
}

// createConversationSessions：建会话级表；session_key 作为前端锚点，源原生 id 与 source_id 联合唯一。
function createConversationSessions(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_sessions (
      session_key TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      native_session_id TEXT,
      cwd TEXT,
      title TEXT,
      started_at TEXT,
      ended_at TEXT,
      source_file TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(source_id) REFERENCES conversation_sources(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_sessions_source ON conversation_sessions(source_id);
    CREATE INDEX IF NOT EXISTS idx_conversation_sessions_cwd ON conversation_sessions(cwd);
    CREATE INDEX IF NOT EXISTS idx_conversation_sessions_ended ON conversation_sessions(ended_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_sessions_native
      ON conversation_sessions(source_id, native_session_id)
      WHERE native_session_id IS NOT NULL;
  `);
}

// createConversationsTable：消息表结构，session_key 指向会话表，使用 trigram FTS5 提供全文检索。
function createConversationsTable(db, tableName = 'conversations') {
  db.exec(`
    CREATE TABLE ${tableName} (
      id TEXT PRIMARY KEY,
      source_id TEXT,
      session_id TEXT,
      session_key TEXT,
      native_message_id TEXT,
      message_index INTEGER NOT NULL DEFAULT 0,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
      content TEXT,
      tool_calls TEXT,
      tool_call_id TEXT,
      metadata TEXT,
      user_text TEXT,
      ended_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      cwd TEXT,
      source_file TEXT,
      FOREIGN KEY(source_id) REFERENCES conversation_sources(id) ON DELETE SET NULL,
      FOREIGN KEY(session_key) REFERENCES conversation_sessions(session_key) ON DELETE CASCADE
    );
  `);
}

// rebuildConversations：当旧 conversations 表为 1.2 的生成列结构或 source_id NOT NULL 时，
// 把数据迁到新结构 conversations_v13，丢弃不兼容约束以承接历史数据。
function rebuildConversations(db) {
  const oldColumns = columns(db, 'conversations');
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'conversations'").get()?.sql || '';
  const needsRebuild = /user_text\s+TEXT\s+GENERATED/i.test(schema) || /source_id\s+TEXT\s+NOT\s+NULL/i.test(schema);
  if (!needsRebuild) return;

  createConversationsTable(db, 'conversations_v13');
  const targetColumns = [
    'id', 'source_id', 'session_id', 'session_key', 'native_message_id', 'message_index',
    'role', 'content', 'tool_calls', 'tool_call_id', 'metadata', 'user_text', 'ended_at',
    'created_at', 'cwd', 'source_file',
  ];
  const selectExpressions = targetColumns.map((name) => {
    if (name === 'user_text' && !oldColumns.has('user_text')) return "CASE WHEN role = 'user' THEN content ELSE NULL END";
    if (name === 'message_index' && !oldColumns.has(name)) return '0';
    return oldColumns.has(name) ? name : 'NULL';
  });
  db.exec(`
    INSERT INTO conversations_v13 (${targetColumns.join(', ')})
    SELECT ${selectExpressions.join(', ')} FROM conversations;
    DROP TABLE conversations;
    ALTER TABLE conversations_v13 RENAME TO conversations;
  `);
}

// createOrUpgradeConversations：消息表的总入口，必要时先重建表，再幂等补 1.3 新列与索引。
function createOrUpgradeConversations(db) {
  if (!tableExists(db, 'conversations')) createConversationsTable(db);
  rebuildConversations(db);
  addColumn(db, 'conversations', 'session_key TEXT');
  addColumn(db, 'conversations', 'native_message_id TEXT');
  addColumn(db, 'conversations', 'message_index INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'conversations', 'cwd TEXT');
  addColumn(db, 'conversations', 'source_file TEXT');

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_conversations_source_id ON conversations(source_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_session_id ON conversations(session_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_session_key ON conversations(session_key, message_index);
    CREATE INDEX IF NOT EXISTS idx_conversations_source_file ON conversations(source_id, source_file);
    CREATE INDEX IF NOT EXISTS idx_conversations_ended_at ON conversations(ended_at);
    CREATE INDEX IF NOT EXISTS idx_conversations_role ON conversations(role);
    CREATE INDEX IF NOT EXISTS idx_conversations_cwd ON conversations(cwd);
  `);
}

// createOrUpgradeWorkspaces：建工作区与标签表，并补齐 1.3 引入的标签扩展字段（label、create_request_id、退出码等）。
function createOrUpgradeWorkspaces(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      last_active_at TEXT,
      session_count INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS tab_sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      pty_status TEXT CHECK (pty_status IN ('running','ended','error')),
      created_at TEXT,
      killed_at TEXT,
      last_ws_seen_at TEXT,
      label TEXT,
      create_request_id TEXT,
      ended_at TEXT,
      exit_code INTEGER,
      exit_signal TEXT,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
    );
  `);
  addColumn(db, 'tab_sessions', 'label TEXT');
  addColumn(db, 'tab_sessions', 'create_request_id TEXT');
  addColumn(db, 'tab_sessions', 'ended_at TEXT');
  addColumn(db, 'tab_sessions', 'exit_code INTEGER');
  addColumn(db, 'tab_sessions', 'exit_signal TEXT');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tab_sessions_workspace_id ON tab_sessions(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_tab_sessions_last_ws_seen_at ON tab_sessions(last_ws_seen_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tab_sessions_create_request
      ON tab_sessions(create_request_id) WHERE create_request_id IS NOT NULL;
  `);
}

// recreateConversationFts：重建 FTS5 倒排索引与触发器，覆盖 content + user_text 双字段并支持 trigram。
function recreateConversationFts(db) {
  db.exec(`
    DROP TRIGGER IF EXISTS conversations_ai;
    DROP TRIGGER IF EXISTS conversations_ad;
    DROP TRIGGER IF EXISTS conversations_au;
    DROP TABLE IF EXISTS conversations_fts;
    CREATE VIRTUAL TABLE conversations_fts USING fts5(
      content,
      user_text,
      content='conversations',
      content_rowid='rowid',
      tokenize='trigram'
    );
    CREATE TRIGGER conversations_ai AFTER INSERT ON conversations BEGIN
      INSERT INTO conversations_fts(rowid, content, user_text)
      VALUES (new.rowid, new.content, new.user_text);
    END;
    CREATE TRIGGER conversations_ad AFTER DELETE ON conversations BEGIN
      INSERT INTO conversations_fts(conversations_fts, rowid, content, user_text)
      VALUES ('delete', old.rowid, old.content, old.user_text);
    END;
    CREATE TRIGGER conversations_au AFTER UPDATE ON conversations BEGIN
      INSERT INTO conversations_fts(conversations_fts, rowid, content, user_text)
      VALUES ('delete', old.rowid, old.content, old.user_text);
      INSERT INTO conversations_fts(rowid, content, user_text)
      VALUES (new.rowid, new.content, new.user_text);
    END;
    INSERT INTO conversations_fts(conversations_fts) VALUES ('rebuild');
  `);
}

/**
 * 读取当前 schema_migrations 中已应用的最大版本号；表不存在视为 0。
 * @param {import('better-sqlite3').Database} db
 */
export function readSchemaVersion(db) {
  if (!tableExists(db, 'schema_migrations')) return 0;
  return db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get().version;
}

/**
 * 执行数据库迁移到 DATABASE_SCHEMA_VERSION。
 * 已达到目标版本时直接返回；否则在关闭外键的临时事务里建表、升级、补列、重建 FTS。
 * @param {import('better-sqlite3').Database} db
 */
export function migrateDatabase(db) {
  if (readSchemaVersion(db) >= DATABASE_SCHEMA_VERSION) return DATABASE_SCHEMA_VERSION;

  // SQLite 不能在事务内切换 foreign_keys；先关闭以允许兼容旧生成列表结构的重建。
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      createConversationSources(db);
      createConversationSessions(db);
      createOrUpgradeConversations(db);
      createOrUpgradeWorkspaces(db);
      recreateConversationFts(db);
      // 1.2 数据的归属不可信，后续导入只有完整成功后才能清除此标记。
      db.prepare('UPDATE conversation_sources SET needs_reconcile = 1').run();
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)')
        .run(DATABASE_SCHEMA_VERSION, 'nterminal-1.3');
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  return readSchemaVersion(db);
}
