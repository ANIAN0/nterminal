/**
 * SQLite 数据库初始化与 CRUD 操作模块。
 * 提供对话源管理、对话记录存储、补全查询、全文检索、分页查询能力。
 *
 * 架构：
 * - conversation_sources 表：对话源配置
 * - conversations 表：统一对话记录
 * - conversations_fts 虚拟表：FTS5 全文索引
 */

import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import {
  DATABASE_SCHEMA_VERSION,
  migrateDatabase,
  readSchemaVersion,
} from './database-migrations.mjs';

/** @type {import('better-sqlite3').Database | null} */
let db = null;

/**
 * 初始化 SQLite 数据库，创建表和索引。
 * @param {string} dbPath - 数据库文件路径
 * @returns {Database} 数据库实例
 */
export function initializeDatabase(dbPath) {
  const dir = dirname(dbPath);
  mkdirSync(dir, { recursive: true });
  if (db && db.name === dbPath) return db;
  if (db) {
    db.close();
    db = null;
  }
  const existed = existsSync(dbPath) && statSync(dbPath).size > 0;
  let currentVersion = 0;
  if (existed) {
    const probe = new Database(dbPath);
    currentVersion = readSchemaVersion(probe);
    if (currentVersion < DATABASE_SCHEMA_VERSION) {
      // checkpoint 后关闭连接再复制，保证备份不遗漏 WAL 中已提交的数据。
      probe.pragma('wal_checkpoint(TRUNCATE)');
    }
    probe.close();
  }

  const backupPath = `${dbPath}.pre-1.3.bak`;
  if (existed && currentVersion < DATABASE_SCHEMA_VERSION) {
    if (existsSync(backupPath)) {
      const backupStat = statSync(backupPath);
      // 同名目录或空文件不能提供恢复能力，必须阻止迁移而不是误判为已有备份。
      if (!backupStat.isFile() || backupStat.size === 0) {
        throw new Error('迁移备份路径不是有效的非空文件');
      }
    } else {
      copyFileSync(dbPath, backupPath);
    }
  }

  try {
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    // 与 worker 线程保持一致：写锁最多等待 5 秒。同步主线程会在 worker 跑
    // replaceSourceData 大事务的同时写 conversation_sources.sync_state / last_error_*，
    // 没有 busy_timeout 会让主线程立即抛出 SQLITE_BUSY，进而变成 unhandledRejection。
    db.pragma('busy_timeout = 5000');
    migrateDatabase(db);
    db.pragma('foreign_keys = ON');
    return db;
  } catch (error) {
    db?.close();
    db = null;
    throw error;
  }
}

export function getSchemaVersion() {
  return readSchemaVersion(getDb());
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
    INSERT INTO conversation_sources (id, path, agent_type, label, needs_reconcile, sync_state)
    VALUES (?, ?, ?, ?, 1, 'idle')
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
    SELECT id, path, agent_type, label, metadata, last_synced_at, record_count, status,
           enabled, sync_state, needs_reconcile, last_attempt_at, last_success_at,
           last_error_code, last_error_message, last_error_at
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
    enabled: Boolean(row.enabled),
    syncState: row.sync_state,
    needsReconcile: Boolean(row.needs_reconcile),
    lastAttemptAt: row.last_attempt_at,
    lastSuccessAt: row.last_success_at,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    lastErrorAt: row.last_error_at,
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
  const boundedLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 50);
  const normalized = String(query).trim();

  if (normalized === '*') {
    return database.prepare(`
      SELECT c.* FROM conversations c
      ORDER BY c.ended_at DESC, c.rowid DESC
      LIMIT ?
    `).all(boundedLimit).map((row) => ({ conversation: row, snippet: row.content, rank: 0 }));
  }

  // trigram 至少需要三个 Unicode 字符；更短输入走有界 LIKE，避免 MATCH 无结果。
  if (Array.from(normalized).length >= 3) {
    const quoted = `"${normalized.replace(/"/g, '""')}"`;
    const matchExpression = scope === 'user' ? `user_text : ${quoted}` : quoted;
    const rows = database.prepare(`
      SELECT c.*, snippet(conversations_fts, 0, '', '', '…', 24) AS search_snippet,
             bm25(conversations_fts) AS search_rank
      FROM conversations_fts
      JOIN conversations c ON c.rowid = conversations_fts.rowid
      WHERE conversations_fts MATCH ?
      ORDER BY search_rank, c.ended_at DESC, c.rowid DESC
      LIMIT ?
    `).all(matchExpression, boundedLimit);
    return rows.map(({ search_snippet, search_rank, ...conversation }) => ({
      conversation,
      snippet: search_snippet || conversation.content,
      rank: search_rank,
    }));
  }

  // 转义 LIKE 通配符，保证用户输入只表达字面量，不改变 SQL 匹配范围。
  const escaped = normalized.replace(/[\\%_]/g, '\\$&');
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
  const params = scope === 'user' ? [pattern, boundedLimit] : [pattern, pattern, boundedLimit];
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

/**
 * 关闭数据库连接。
 */
export function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}
