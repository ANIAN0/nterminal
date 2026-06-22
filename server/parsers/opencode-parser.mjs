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

import { Database } from '@tursodatabase/database/compat';
import { normalizeRole } from './_shared/role-mapper.mjs';

/**
 * 解析 Opencode SQLite 数据库中的对话。
 *
 * @param {string} filePath - opencode.db 文件路径
 * @returns {Array<{ role: string, content: string|null, toolCalls: string|null, toolCallId: string|null, timestamp: string|null }>} 解析结果
 */
export function parseSessionFile(filePath) {
  const db = new Database(filePath, { readonly: true });

  try {
    // 查询所有 message 按时间排序
    const messages = db
      .prepare('SELECT id, session_id, time_created, data FROM message ORDER BY time_created')
      .all();

    const results = [];

    for (const msg of messages) {
      const msgData = JSON.parse(msg.data);
      const rawRole = msgData.role;
      const role = normalizeRole('opencode', rawRole);
      const timestamp = msg.time_created ? new Date(msg.time_created).toISOString() : null;

      // 查询该 message 关联的所有 part
      const parts = db
        .prepare("SELECT id, data FROM part WHERE message_id = ? ORDER BY time_created")
        .all(msg.id);

      if (role === 'user') {
        // user message：从 type='text' 的 part 提取文本
        const textParts = parts.filter((p) => {
          const d = JSON.parse(p.data);
          return d.type === 'text';
        });

        const text = textParts
          .map((p) => JSON.parse(p.data).text)
          .filter(Boolean)
          .join('\n');

        if (text) {
          results.push({
            role: 'user',
            content: text,
            toolCalls: null,
            toolCallId: null,
            timestamp,
          });
        }
      } else if (role === 'assistant') {
        // assistant message：从 type='text' 的 part 提取文本
        const textParts = parts.filter((p) => {
          const d = JSON.parse(p.data);
          return d.type === 'text';
        });

        const text = textParts
          .map((p) => JSON.parse(p.data).text)
          .filter(Boolean)
          .join('\n');

        if (text) {
          results.push({
            role: 'assistant',
            content: text,
            toolCalls: null,
            toolCallId: null,
            timestamp,
          });
        }

        // 从 type='tool' 的 part 提取工具调用，作为独立记录
        const toolParts = parts.filter((p) => {
          const d = JSON.parse(p.data);
          return d.type === 'tool';
        });

        for (const tp of toolParts) {
          const toolData = JSON.parse(tp.data);
          results.push({
            role: 'tool',
            content: JSON.stringify({
              tool: toolData.tool,
              state: toolData.state,
            }),
            toolCalls: null,
            toolCallId: toolData.callID || null,
            timestamp,
          });
        }
      }
      // system 和其他 role 跳过（opencode 中无 system role）
    }

    return results;
  } finally {
    db.close();
  }
}
