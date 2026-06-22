/**
 * SQLite 数据库初始化与 CRUD 操作模块。
 * 提供对话源管理、对话记录存储、补全查询、全文检索、分页查询能力。
 *
 * 架构：
 * - conversation_sources 表：对话源配置
 * - conversations 表：统一对话记录
 * - conversations_fts 虚拟表：FTS5 全文索引
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from '@tursodatabase/database/compat';

/** @type {Database | null} */
let db = null;

/**
 * 升级 conversation_sources 表的 agent_type CHECK 约束，添加 opencode。
 * @param {Database} database
 */
function upgradeAgentTypeCheck(database) {
  // 检查当前 conversation_sources 表的 CREATE 语句是否包含 opencode
  const row = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='conversation_sources'"
  ).get();
  if (!row || !row.sql) return;
  if (/opencode/.test(row.sql)) return; // 已包含

  // 临时禁用外键约束（重建表时需要）
  database.pragma('foreign_keys = OFF');

  // 使用重建表策略（REV-002-07 锁定）
  database.exec(`
    CREATE TABLE conversation_sources_new (
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
  `);
  database.exec(`INSERT INTO conversation_sources_new SELECT * FROM conversation_sources`);
  database.exec(`DROP TABLE conversation_sources`);
  database.exec(`ALTER TABLE conversation_sources_new RENAME TO conversation_sources`);

  // 恢复外键约束
  database.pragma('foreign_keys = ON');
}

/**
 * 添加 conversations.cwd 列（如果缺失）。
 * @param {Database} database
 */
function addCwdColumnIfMissing(database) {
  const columns = database.prepare("PRAGMA table_info(conversations)").all();
  if (columns.some(col => col.name === 'cwd')) return; // 已存在
  database.exec(`ALTER TABLE conversations ADD COLUMN cwd TEXT`);
  database.exec(`CREATE INDEX IF NOT EXISTS idx_conversations_cwd ON conversations(cwd)`);
}

/**
 * 把旧版生成列迁移为普通列。Turso 默认不启用生成列，显式存储还能兼容纯文本 content。
 * @param {Database} database
 */
function upgradeConversationSchema(database) {
  const row = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='conversations'"
  ).get();
  if (!row?.sql) return;
  const hasGeneratedUserText = /user_text\s+TEXT\s+GENERATED/i.test(row.sql);
  const hasRequiredSource = /source_id\s+TEXT\s+NOT\s+NULL/i.test(row.sql);
  if (!hasGeneratedUserText && !hasRequiredSource) return;
  const userTextExpression = hasGeneratedUserText
    ? "CASE WHEN role = 'user' THEN content ELSE NULL END"
    : 'user_text';

  // 重建期间关闭外键，避免重命名旧表时改写引用关系。
  database.pragma('foreign_keys = OFF');
  try {
    database.exec(`
      DROP TRIGGER IF EXISTS conversations_ai;
      DROP TRIGGER IF EXISTS conversations_ad;
      DROP TRIGGER IF EXISTS conversations_au;
      DROP TABLE IF EXISTS conversations_fts;
      ALTER TABLE conversations RENAME TO conversations_legacy;
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
      INSERT INTO conversations (
        id, source_id, session_id, role, content, tool_calls, tool_call_id,
        metadata, user_text, ended_at, created_at, cwd
      )
      SELECT
        id, source_id, session_id, role, content, tool_calls, tool_call_id,
        metadata, ${userTextExpression},
        ended_at, created_at, cwd
      FROM conversations_legacy;
      DROP TABLE conversations_legacy;
    `);
  } finally {
    database.pragma('foreign_keys = ON');
  }
}

/**
 * 初始化 SQLite 数据库，创建表和索引。
 * @param {string} dbPath - 数据库文件路径
 * @returns {Database} 数据库实例
 */
export function initializeDatabase(dbPath) {
  // 确保数据目录存在
  const dir = dirname(dbPath);
  mkdirSync(dir, { recursive: true });

  // 如果 db 已存在且路径相同，直接返回（避免重复初始化）
  if (db && db.name === dbPath) return db;

  // 如果 db 已存在但路径不同，关闭旧连接
  if (db) {
    db.close();
    db = null;
  }

  db = new Database(dbPath);

  // 启用 WAL 模式（支持并发读写）和 foreign_keys
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // 创建对话源表
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
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // 创建对话记录表
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
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
      FOREIGN KEY(source_id) REFERENCES conversation_sources(id) ON DELETE SET NULL
    );
  `);

  // 旧版生成列无法被 Turso 默认配置解析，启动时迁移为普通列。
  upgradeConversationSchema(db);

  // Turso 当前构建不包含 FTS5；清理旧索引，搜索统一使用参数化 LIKE。
  db.exec(`
    DROP TRIGGER IF EXISTS conversations_ai;
    DROP TRIGGER IF EXISTS conversations_ad;
    DROP TRIGGER IF EXISTS conversations_au;
    DROP TABLE IF EXISTS conversations_fts;
  `);

  // 创建索引
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_conversations_source_id ON conversations(source_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_session_id ON conversations(session_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_ended_at ON conversations(ended_at);
    CREATE INDEX IF NOT EXISTS idx_conversations_role ON conversations(role);
  `);

  // 升级 agent_type CHECK 约束
  upgradeAgentTypeCheck(db);

  // 添加 conversations.cwd 列
  addCwdColumnIfMissing(db);

  // 创建 workspaces 表
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      last_active_at TEXT,
      session_count INTEGER DEFAULT 0
    );
  `);

  // 创建 tab_sessions 表
  db.exec(`
    CREATE TABLE IF NOT EXISTS tab_sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      pty_status TEXT CHECK (pty_status IN ('running','ended','error')),
      created_at TEXT,
      killed_at TEXT,
      last_ws_seen_at TEXT,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
    );
  `);

  // 创建 tab_sessions 索引
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tab_sessions_workspace_id ON tab_sessions(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_tab_sessions_last_ws_seen_at ON tab_sessions(last_ws_seen_at);
  `);

  return db;
}

/**
 * 获取全局数据库实例（必须先调用 initializeDatabase）。
 * @returns {Database.Database}
 */
export function getDb() {
  if (!db) throw new Error('数据库未初始化，请先调用 initializeDatabase()');
  return db;
}

/**
 * 生成 UUID v4。
 * @returns {string}
 */
function generateUUID() {
  return crypto.randomUUID();
}

// ===================== 对话源 CRUD =====================

/**
 * 插入对话源。
 * @param {{ path: string, agentType: string, label?: string }} source
 * @returns {{ id: string, path: string, agentType: string, label: string | null, createdAt: string }}
 */
export function insertConversationSource({ path, agentType, label = null }) {
  const database = getDb();
  const id = generateUUID();
  const stmt = database.prepare(`
    INSERT INTO conversation_sources (id, path, agent_type, label)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(id, path, agentType, label);
  return { id, path, agentType, label, createdAt: new Date().toISOString() };
}

/**
 * 查询所有对话源。
 * @returns {Array<{ id: string, path: string, agentType: string, label: string | null, metadata: string | null, lastSyncedAt: string | null, recordCount: number, status: string }>}
 */
export function listConversationSources() {
  const database = getDb();
  const stmt = database.prepare(`
    SELECT id, path, agent_type, label, metadata, last_synced_at, record_count, status
    FROM conversation_sources
    ORDER BY created_at DESC
  `);
  return stmt.all().map((row) => ({
    id: row.id,
    path: row.path,
    agentType: row.agent_type,
    label: row.label,
    metadata: row.metadata,
    lastSyncedAt: row.last_synced_at,
    recordCount: row.record_count,
    status: row.status,
  }));
}

/**
 * 删除对话源（不删除已导入的对话记录）。
 * @param {string} id
 * @returns {boolean}
 */
export function deleteConversationSource(id) {
  const database = getDb();
  const stmt = database.prepare('DELETE FROM conversation_sources WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

/**
 * 更新对话源同步状态。
 * @param {string} id
 * @param {{ lastSyncedAt?: string, recordCount?: number, status?: string, metadata?: string }} params
 */
export function updateConversationSourceStatus(id, { lastSyncedAt, recordCount, status, metadata }) {
  const database = getDb();
  const sets = [];
  const params = [];

  if (lastSyncedAt) {
    sets.push('last_synced_at = ?');
    params.push(lastSyncedAt);
  }
  if (recordCount !== undefined) {
    sets.push('record_count = ?');
    params.push(recordCount);
  }
  if (status) {
    sets.push('status = ?');
    params.push(status);
  }
  if (metadata !== undefined) {
    sets.push('metadata = ?');
    params.push(metadata);
  }

  if (sets.length === 0) return;

  params.push(id);
  const stmt = database.prepare(`UPDATE conversation_sources SET ${sets.join(', ')} WHERE id = ?`);
  stmt.run(...params);
}

// ===================== 对话记录 CRUD =====================

/**
 * 插入对话记录（忽略重复 id）。
 * @param {{
 *   id: string,
 *   sourceId: string,
 *   sessionId?: string | null,
 *   role: string,
 *   content?: string | null,
 *   toolCalls?: string | null,
 *   toolCallId?: string | null,
 *   metadata?: string | null,
 *   endedAt?: string | null
 * }} record
 * @returns {boolean}
 */
export function insertConversation({
  id,
  sourceId,
  sessionId = null,
  role,
  content = null,
  toolCalls = null,
  toolCallId = null,
  metadata = null,
  endedAt = null,
}) {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT OR IGNORE INTO conversations (id, source_id, session_id, role, content, tool_calls, tool_call_id, metadata, user_text, ended_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // 只有用户输入参与补全，避免助手输出污染候选词。
  const userText = role === 'user' ? content : null;
  const result = stmt.run(id, sourceId, sessionId, role, content, toolCalls, toolCallId, metadata, userText, endedAt);
  return result.changes > 0;
}

/**
 * 批量插入对话记录（使用事务）。
 * @param {Array<Parameters<typeof insertConversation>[0]>} records
 * @returns {number} 实际插入条数
 */
export function insertConversationsBatch(records) {
  const database = getDb();
  const insert = database.prepare(`
    INSERT OR IGNORE INTO conversations (id, source_id, session_id, role, content, tool_calls, tool_call_id, metadata, user_text, ended_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const transaction = database.transaction(() => {
    let count = 0;
    for (const record of records) {
      const result = insert.run(
        record.id,
        record.sourceId,
        record.sessionId || null,
        record.role,
        record.content || null,
        record.toolCalls || null,
        record.toolCallId || null,
        record.metadata || null,
        record.role === 'user' ? record.content || null : null,
        record.endedAt || null,
      );
      count += result.changes;
    }
    return count;
  });

  return transaction();
}

// ===================== 补全查询 =====================

/**
 * 补全查询：前缀匹配 + 频率排序。
 * @param {string} prefix - 输入前缀
 * @param {number} limit - 返回条数
 * @returns {Array<{ userText: string, count: number, lastUsedAt: string }>}
 */
export function queryCompletion(prefix, limit = 8) {
  const database = getDb();
  const stmt = database.prepare(`
    SELECT user_text AS userText, COUNT(*) AS count, MAX(ended_at) AS lastUsedAt
    FROM conversations
    WHERE role = 'user' AND user_text LIKE ?
    GROUP BY user_text
    ORDER BY count DESC, lastUsedAt DESC
    LIMIT ?
  `);
  return stmt.all(`${prefix}%`, limit);
}

// ===================== 全文检索 =====================

/**
 * 对话文本检索。
 * @param {string} query - 搜索关键词
 * @param {'all' | 'user'} scope - 搜索范围
 * @param {number} limit - 返回条数
 * @returns {Array<{ conversation: object, snippet: string, rank: number }>}
 */
export function searchConversations(query, scope = 'all', limit = 20) {
  const database = getDb();

  // “*” 用于首页统计预览；普通查询转义 LIKE 通配符，避免输入改变匹配语义。
  const escaped = query === '*' ? '' : query.replace(/[\\%_]/g, '\\$&');
  const pattern = `%${escaped}%`;
  const condition = scope === 'user'
    ? "c.user_text LIKE ? ESCAPE '\\'"
    : "(c.user_text LIKE ? ESCAPE '\\' OR c.content LIKE ? ESCAPE '\\')";
  const stmt = database.prepare(`
    SELECT c.*
    FROM conversations c
    WHERE ${condition}
    ORDER BY c.ended_at DESC, c.rowid DESC
    LIMIT ?
  `);
  const params = scope === 'user' ? [pattern, limit] : [pattern, pattern, limit];
  return stmt.all(...params).map((row) => ({
    conversation: row,
    snippet: row.content,
    rank: 0,
  }));
}

// ===================== 分页查询 =====================

/**
 * Cursor 分页查询对话记录。
 * @param {string|null} cursor - base64 编码的 "endedAt:rowid"
 * @param {number} limit - 每页条数
 * @param {string|null} agentType - agent 类型筛选
 * @returns {{ items: object[], nextCursor: string | null, total: number }}
 */
export function listConversations(cursor = null, limit = 50, agentType = null) {
  const database = getDb();

  // 解码 cursor
  let endedAt = null;
  let rowid = null;
  if (cursor) {
    try {
      const decoded = Buffer.from(cursor, 'base64').toString('utf-8');
      const parts = decoded.split(':');
      endedAt = parts[0];
      rowid = parseInt(parts[1], 10);
    } catch {
      // cursor 无效，忽略
    }
  }

  // 构建查询条件
  const conditions = [];
  const params = [];

  if (endedAt && rowid !== null && !Number.isNaN(rowid)) {
    conditions.push('(c.ended_at < ? OR (c.ended_at = ? AND c.rowid < ?))');
    params.push(endedAt, endedAt, rowid);
  }

  if (agentType) {
    conditions.push('cs.agent_type = ?');
    params.push(agentType);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // 查询数据
  const dataStmt = database.prepare(`
    SELECT c.*
    FROM conversations c
    LEFT JOIN conversation_sources cs ON c.source_id = cs.id
    ${whereClause}
    ORDER BY c.ended_at DESC, c.rowid DESC
    LIMIT ?
  `);
  const items = dataStmt.all(...params, limit + 1);

  // 判断是否有下一页
  const hasMore = items.length > limit;
  if (hasMore) items.pop();

  // 生成 nextCursor
  let nextCursor = null;
  if (hasMore && items.length > 0) {
    const last = items[items.length - 1];
    nextCursor = Buffer.from(`${last.ended_at}:${last.rowid}`).toString('base64');
  }

  // 查询总数
  const totalStmt = database.prepare(`
    SELECT COUNT(*) AS total
    FROM conversations c
    LEFT JOIN conversation_sources cs ON c.source_id = cs.id
    ${whereClause}
  `);
  const totalRow = totalStmt.get(...params);

  return {
    items,
    nextCursor,
    total: totalRow?.total || 0,
  };
}

/** 按 ID 查询单条对话。 */
export function getConversationById(id) {
  return getDb().prepare('SELECT * FROM conversations WHERE id = ?').get(id) || null;
}

/** 删除单条对话并返回是否命中。 */
export function deleteConversation(id) {
  return getDb().prepare('DELETE FROM conversations WHERE id = ?').run(id).changes > 0;
}

/**
 * 关闭数据库连接。
 */
export function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}
