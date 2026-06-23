/**
 * Opencode 对话历史解析器
 *
 * Opencode 使用 SQLite 数据库存储对话。
 * message 表存储消息（user/assistant），part 表存储消息的各部分（text/tool 等）。
 *
 * 解析策略：
 *   1. 读取所有 message 按 time_created 排序
 *   2. 对每个 message，查询关联的 part
 *   3. user message → 从 type='text' 的 part 提取文本
 *   4. assistant message → 从 type='text' 的 part 提取文本，从 type='tool' 的 part 提取工具调用
 *   5. tool part 作为独立的 tool 记录
 */

import Database from 'better-sqlite3';
import { normalizeRole } from './_shared/role-mapper.mjs';

// readOpenCodeRevision：取 message.time_updated 最大值作为变更标记，决定 worker 是否跳过同步。
export function readOpenCodeRevision(filePath) {
  const db = new Database(filePath, { readonly: true });
  try {
    return db.prepare('SELECT MAX(time_updated) AS revision FROM message').get()?.revision ?? null;
  } finally {
    db.close();
  }
}

/**
 * 解析 Opencode SQLite 数据库中的对话。
 *
 * @param {string} filePath - opencode.db 文件路径
 * @returns {Array<{ role: string, content: string|null, toolCalls: string|null, toolCallId: string|null, timestamp: string|null }>} 解析结果
 */
export function parseSessionFile(filePath) {
  return parseSessionFilesWithMeta(filePath).flatMap((session) => session.messages);
}

/**
 * 按 OpenCode 原生 session 分组解析，返回带 sessionId/cwd/title/startedAt/endedAt 的会话数组。
 * 一次 JOIN 把 session/message/part 三表拉平后按内存 Map 重组，规避对运行库逐条 part 查询。
 * @param {string} filePath
 * @returns {Array<{sessionId: string, cwd: string|null, title: string|null,
 *                  startedAt: string|null, endedAt: string|null,
 *                  messages: Array<{nativeMessageId: string, role: string, content: string|null,
 *                                   toolCalls: string|null, toolCallId: string|null, timestamp: string|null}>}>}
 */
export function parseSessionFilesWithMeta(filePath) {
  const db = new Database(filePath, { readonly: true });

  try {
    const rows = db.prepare(`
      SELECT
        s.id AS session_id, s.directory, s.title,
        s.time_created AS session_created, s.time_updated AS session_updated,
        m.id AS message_id, m.time_created AS message_created, m.data AS message_data,
        p.id AS part_id, p.time_created AS part_created, p.data AS part_data
      FROM message m
      JOIN session s ON s.id = m.session_id
      LEFT JOIN part p ON p.message_id = m.id
      ORDER BY s.time_created, m.time_created, p.time_created, p.id
    `).all();
    const sessions = new Map();
    const messages = new Map();

    for (const row of rows) {
      if (!sessions.has(row.session_id)) {
        sessions.set(row.session_id, {
          sessionId: row.session_id,
          cwd: row.directory || null,
          title: row.title || null,
          startedAt: row.session_created ? new Date(row.session_created).toISOString() : null,
          endedAt: row.session_updated ? new Date(row.session_updated).toISOString() : null,
          messages: [],
        });
      }
      if (!messages.has(row.message_id)) {
        messages.set(row.message_id, {
          id: row.message_id,
          sessionId: row.session_id,
          timestamp: row.message_created ? new Date(row.message_created).toISOString() : null,
          role: normalizeRole('opencode', JSON.parse(row.message_data).role),
          parts: [],
        });
      }
      if (row.part_id) messages.get(row.message_id).parts.push({ id: row.part_id, data: JSON.parse(row.part_data) });
    }

    for (const message of messages.values()) {
      const session = sessions.get(message.sessionId);
      const text = message.parts
        .filter((part) => part.data.type === 'text')
        .map((part) => part.data.text)
        .filter(Boolean)
        .join('\n');
      if (text) {
        session.messages.push({
          nativeMessageId: message.id,
          role: message.role,
          content: text,
          toolCalls: null,
          toolCallId: null,
          timestamp: message.timestamp,
        });
      }
      for (const part of message.parts.filter((item) => item.data.type === 'tool')) {
        session.messages.push({
          nativeMessageId: part.id,
          role: 'tool',
          content: JSON.stringify({ tool: part.data.tool, state: part.data.state }),
          toolCalls: null,
          toolCallId: part.data.callID || null,
          timestamp: message.timestamp,
        });
      }
    }
    return [...sessions.values()];
  } finally {
    db.close();
  }
}
