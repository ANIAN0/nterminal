/**
 * 历史会话服务。
 * 提供 listHistorySessions（全量/短查询走 LIKE/长查询走 FTS5）和 getHistorySession 详情读取，
 * 把分页、源状态、消息列表等组装成 HistorySessionsResponse 形态供前端消费。
 */

import { getDb } from './database.mjs';

// HistoryServiceError：历史服务错误，附 HTTP 状态码用于路由转译。
export class HistoryServiceError extends Error {
  constructor(code, message, status = 400) {
    super(`${code}: ${message}`);
    this.name = 'HistoryServiceError';
    this.code = code;
    this.status = status;
  }
}

// toBoundedLimit：把 limit 收敛到 [1, 100]，避免前端误传大值拖慢数据库。
function toBoundedLimit(value, fallback = 50) {
  return Math.min(Math.max(Number.parseInt(value ?? fallback, 10) || fallback, 1), 100);
}

// countCharacters：按 Unicode 码点统计字符数，替代 length 以正确处理代理对。
function countCharacters(value) {
  return Array.from(String(value || '').trim()).length;
}

// escapeLike：转义 SQL LIKE 通配符，保证用户输入只表达字面量。
function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, '\\$&');
}

// quoteFts：用双引号包裹 FTS5 表达式，规避空格/特殊字符触发的语法错误。
function quoteFts(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

// sourceStateFromRow：把 conversation_sources 行映射为前端可消费的 sourceState。
function sourceStateFromRow(row) {
  return {
    sourceId: row.id,
    agentType: row.agent_type,
    label: row.label,
    path: row.path,
    state: row.status,
    syncState: row.sync_state,
    recordCount: row.record_count,
    lastSyncedAt: row.last_synced_at,
    errorCode: row.last_error_code,
    errorMessage: row.last_error_message,
    errorAt: row.last_error_at,
  };
}

// sessionFromRow：把 session 行映射为前端可消费的 HistorySessionSummary。
function sessionFromRow(row, snippet = null) {
  return {
    sessionKey: row.session_key,
    sourceId: row.source_id,
    nativeSessionId: row.native_session_id,
    cwd: row.cwd || row.source_path || null,
    title: row.title || row.native_session_id || row.session_key,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    sourceFile: row.source_file,
    messageCount: row.message_count,
    snippet,
  };
}

// messageFromRow：把 conversations 行映射为 HistoryMessage，字段全部 camelCase。
function messageFromRow(row) {
  return {
    id: row.id,
    sourceId: row.source_id,
    sessionId: row.session_id,
    sessionKey: row.session_key,
    nativeMessageId: row.native_message_id,
    messageIndex: row.message_index,
    role: row.role,
    content: row.content,
    toolCalls: row.tool_calls,
    toolCallId: row.tool_call_id,
    metadata: row.metadata,
    userText: row.user_text,
    endedAt: row.ended_at,
    createdAt: row.created_at,
    cwd: row.cwd,
    sourceFile: row.source_file,
  };
}

// loadSourceStates：把全部对话源状态按 rowid 顺序返回，前端用于展示同步指示。
function loadSourceStates(db) {
  return db.prepare(`
    SELECT id, path, agent_type, label, status, sync_state, record_count,
           last_synced_at, last_error_code, last_error_message, last_error_at
    FROM conversation_sources
    ORDER BY rowid ASC
  `).all().map(sourceStateFromRow);
}

// selectAllSessions：无查询时直接按时间倒序列出会话。
function selectAllSessions(db, limit) {
  return {
    searchMode: 'all',
    rows: db.prepare(`
      SELECT s.*, cs.path AS source_path, cs.agent_type, cs.label AS source_label,
             cs.status AS source_status
      FROM conversation_sessions s
      JOIN conversation_sources cs ON cs.id = s.source_id
      ORDER BY COALESCE(s.ended_at, s.started_at, s.updated_at) DESC, s.session_key DESC
      LIMIT ?
    `).all(limit + 1),
  };
}

// selectLikeSessions：短查询（<3 字符）走有界 LIKE，避免 trigram FTS5 无结果。
function selectLikeSessions(db, query, limit) {
  const pattern = `%${escapeLike(query)}%`;
  return {
    searchMode: 'like',
    rows: db.prepare(`
      SELECT s.*, cs.path AS source_path, cs.agent_type, cs.label AS source_label,
             cs.status AS source_status, MIN(c.content) AS snippet
      FROM conversations c
      JOIN conversation_sessions s ON s.session_key = c.session_key
      JOIN conversation_sources cs ON cs.id = s.source_id
      WHERE c.user_text LIKE ? ESCAPE '\\' OR c.content LIKE ? ESCAPE '\\'
      GROUP BY s.session_key
      ORDER BY MAX(COALESCE(c.ended_at, s.ended_at, s.started_at)) DESC, s.session_key DESC
      LIMIT ?
    `).all(pattern, pattern, limit + 1),
  };
}

// selectFtsSessions：长查询（≥3 字符）走 trigram FTS5 + bm25 排序，结果带命中片段。
function selectFtsSessions(db, query, limit) {
  const matchExpression = quoteFts(query);
  return {
    searchMode: 'fts',
    rows: db.prepare(`
      SELECT s.*, cs.path AS source_path, cs.agent_type, cs.label AS source_label,
             cs.status AS source_status,
             MIN(c.content) AS snippet
      FROM conversations_fts
      JOIN conversations c ON c.rowid = conversations_fts.rowid
      JOIN conversation_sessions s ON s.session_key = c.session_key
      JOIN conversation_sources cs ON cs.id = s.source_id
      WHERE conversations_fts MATCH ?
      GROUP BY s.session_key
      ORDER BY MAX(COALESCE(c.ended_at, s.ended_at, s.started_at)) DESC, s.session_key DESC
      LIMIT ?
    `).all(matchExpression, limit + 1),
  };
}

// groupSessions：把扁平结果按 sourceId → cwd 两层聚合为前端需要的树形 groups。
function groupSessions(rows) {
  const sourceMap = new Map();
  for (const row of rows) {
    const sourceId = row.source_id;
    if (!sourceMap.has(sourceId)) {
      sourceMap.set(sourceId, {
        sourceId,
        agentType: row.agent_type,
        label: row.source_label,
        state: row.source_status,
        workspaces: [],
      });
    }
    const source = sourceMap.get(sourceId);
    const cwd = row.cwd || row.source_path || '未知目录';
    let workspace = source.workspaces.find((item) => item.cwd === cwd);
    if (!workspace) {
      workspace = { cwd, displayName: cwd.split(/[\\/]/).filter(Boolean).at(-1) || cwd, sessions: [] };
      source.workspaces.push(workspace);
    }
    workspace.sessions.push(sessionFromRow(row, row.snippet || null));
  }
  return Array.from(sourceMap.values());
}

/**
 * 列出历史会话（按 sourceId/cwd 分组，附带 sourceStates 与分页信息）。
 * query 缺省视为 "*"；>=3 字符走 FTS5，否则走 LIKE。
 * @param {{query?: string, limit?: number}} [options]
 */
export function listHistorySessions(options = {}) {
  const db = getDb();
  const limit = toBoundedLimit(options.limit, 50);
  const query = String(options.query ?? '*').trim() || '*';
  const selection = query === '*'
    ? selectAllSessions(db, limit)
    : countCharacters(query) >= 3
      ? selectFtsSessions(db, query, limit)
      : selectLikeSessions(db, query, limit);

  const hasMore = selection.rows.length > limit;
  const rows = hasMore ? selection.rows.slice(0, limit) : selection.rows;

  return {
    groups: groupSessions(rows),
    pagination: {
      limit,
      hasMore,
      searchMode: selection.searchMode,
      nextCursor: null,
    },
    sourceStates: loadSourceStates(db),
  };
}

/**
 * 读取指定 sourceId/sessionKey 的会话详情与全部消息。
 * 会话不存在时抛出 HistoryServiceError(404)。
 * @param {{sourceId: string, sessionKey: string}} params
 */
export function getHistorySession({ sourceId, sessionKey }) {
  if (typeof sourceId !== 'string' || !sourceId) {
    throw new HistoryServiceError('invalid_source_id', 'sourceId 必须是非空字符串', 400);
  }
  if (typeof sessionKey !== 'string' || !sessionKey) {
    throw new HistoryServiceError('invalid_session_key', 'sessionKey 必须是非空字符串', 400);
  }
  const db = getDb();
  const session = db.prepare(`
    SELECT s.*, cs.path AS source_path, cs.agent_type, cs.label AS source_label,
           cs.status AS source_status
    FROM conversation_sessions s
    JOIN conversation_sources cs ON cs.id = s.source_id
    WHERE s.source_id = ? AND s.session_key = ?
  `).get(sourceId, sessionKey);
  if (!session) {
    throw new HistoryServiceError('history_session_not_found', `历史会话 ${sessionKey} 不存在`, 404);
  }

  const messages = db.prepare(`
    SELECT *
    FROM conversations
    WHERE source_id = ? AND session_key = ?
    ORDER BY message_index ASC, COALESCE(ended_at, created_at) ASC, rowid ASC
  `).all(sourceId, sessionKey).map(messageFromRow);

  return {
    session: sessionFromRow(session),
    source: {
      sourceId: session.source_id,
      agentType: session.agent_type,
      label: session.source_label,
      path: session.source_path,
      state: session.source_status,
    },
    messages,
  };
}
