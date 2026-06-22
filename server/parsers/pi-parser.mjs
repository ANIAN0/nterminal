/**
 * pi-mono 对话历史解析器
 *
 * pi-mono 会话文件格式：
 *   第一行是 session header（JSON），包含 id、timestamp、cwd 等元数据。
 *   后续每行一个 entry（JSON），按 type 字段分发：
 *     - message: 包含 message.role, message.content
 *     - custom_message: 包含 content, customType
 *     - compaction / branch_summary: 跳过（不生成对话记录）
 *
 * session header 格式：
 *   { "type": "session", "version": 3, "id": "...", "timestamp": "...", "cwd": "..." }
 */

import { readFileSync } from 'node:fs';
import { normalizeRole } from './_shared/role-mapper.mjs';

/**
 * 读取 JSONL 文件所有行并解析。
 * @param {string} filePath - 文件路径
 * @returns {object[]} 解析后的 JSON 对象数组
 */
function readJsonl(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter((line) => line.trim());
  const entries = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // 跳过无法解析的行
    }
  }
  return entries;
}

/**
 * 从消息内容中提取纯文本。
 * pi-mono 的 content 可能是字符串或数组。
 * @param {string|Array} content - 消息内容
 * @returns {string} 纯文本
 */
function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((item) => item && item.type === 'text' && item.text)
      .map((item) => item.text)
      .join('\n');
  }
  return '';
}

/**
 * 解析 pi-mono 会话文件。
 *
 * 第一行是 session header，提取 id、timestamp、cwd。
 * 后续 entry 按 type 分发：
 *   - message: 提取 message.role, message.content
 *   - custom_message: 提取 content 和 customType，作为 user 消息
 *   - compaction / branch_summary: 跳过
 *
 * @param {string} filePath - pi-mono 会话文件路径
 * @returns {Array<{ role: string, content: string, timestamp: string|null }>} 解析结果
 */
export function parseSessionFile(filePath) {
  const entries = readJsonl(filePath);
  const results = [];

  // 第一行是 session header
  const header = entries[0];
  if (!header || header.type !== 'session') {
    // 不是有效的 pi-mono 会话文件
    return results;
  }

  // 从 header 提取时间戳作为整个会话的基准时间
  const sessionTimestamp = header.timestamp || null;

  // 从第二条开始遍历 entry
  for (let i = 1; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || !entry.type) continue;

    const type = entry.type;

    if (type === 'message') {
      // 标准消息：提取 role 和 content
      const message = entry.message;
      if (!message || !message.role) continue;

      const text = extractText(message.content);
      if (!text) continue;

      results.push({
        role: normalizeRole('pi', message.role),
        content: text,
        timestamp: entry.timestamp || sessionTimestamp,
      });
    } else if (type === 'custom_message') {
      // 自定义消息：提取 content 和 customType
      const text = extractText(entry.content);
      if (!text) continue;

      // custom_message 默认作为 user 角色处理
      results.push({
        role: normalizeRole('pi', 'user'),
        content: text,
        timestamp: entry.timestamp || sessionTimestamp,
      });
    } else if (type === 'compaction' || type === 'branch_summary') {
      // 压缩摘要和分支摘要：跳过，不生成对话记录
      continue;
    }
    // 其他未知类型跳过
  }

  return results;
}

/**
 * 解析 pi-mono 会话文件，同时返回 session 元数据。
 * @param {string} filePath - 会话文件路径
 * @returns {{ sessionId: string|null, cwd: string|null, timestamp: string|null, messages: Array<{ role: string, content: string, timestamp: string|null }> }}
 */
export function parseSessionFileWithMeta(filePath) {
  const entries = readJsonl(filePath);
  const header = entries[0];

  const sessionId = header && header.id ? header.id : null;
  const cwd = header && header.cwd ? header.cwd : null;
  const timestamp = header && header.timestamp ? header.timestamp : null;

  const messages = parseSessionFile(filePath);

  return { sessionId, cwd, timestamp, messages };
}
