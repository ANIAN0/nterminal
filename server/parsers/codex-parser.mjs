/**
 * Codex 对话历史解析器
 *
 * Codex 事件流 JSONL 文件格式：
 *   每行一个事件对象，按 type 字段分发：
 *     - session_meta: 会话元数据（id, cwd, timestamp）
 *     - response_item:
 *       - message: 包含 role, content
 *       - function_call: 包含 name, arguments
 *       - function_call_output: 包含 tool_use_id (conversation_item_id), output
 *     - event_msg: user_message / agent_message，作为补充消息
 *
 * 消息去重策略：response_item 优先于 event_msg。
 * 如果同一个消息既出现在 event_msg 又出现在 response_item 中，
 * 以 response_item 为准（因为 response_item 包含更完整的结构）。
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
 * 从消息内容数组中提取纯文本。
 * Codex 格式中 content 可能是字符串数组或对象数组（如 [{text: "..."}]）。
 * @param {Array|string} content - 内容
 * @returns {string} 纯文本
 */
function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && item.text) return item.text;
        return null;
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * 解析 Codex 事件流 JSONL 文件。
 *
 * 处理流程：
 *   1. 第一遍：收集 session_meta
 *   2. 第二遍：按 type 分发 response_item 和 event_msg
 *   3. 去重：response_item 优先
 *
 * @param {string} filePath - Codex 会话文件路径
 * @returns {Array<{ role: string, content: string|null, toolCalls: string|null, toolCallId: string|null, timestamp: string|null }>} 解析结果
 */
export function parseSessionFile(filePath) {
  const entries = readJsonl(filePath);
  const results = [];

  // 第一遍：提取 session 元数据
  let sessionId = null;
  let sessionCwd = null;
  let sessionTimestamp = null;

  for (const entry of entries) {
    if (entry.type === 'session_meta') {
      const payload = entry.payload || entry;
      sessionId = payload.id || null;
      sessionCwd = payload.cwd || null;
      sessionTimestamp = payload.timestamp || null;
      break;
    }
  }

  // 第二遍：处理 response_item 和 event_msg
  // 用于去重：记录已处理的 message 文本
  const processedTexts = new Set();

  for (const entry of entries) {
    if (!entry.type) continue;

    if (entry.type === 'response_item') {
      const item = entry.payload;
      if (!item) continue;

      const itemType = item.type;

      if (itemType === 'message') {
        // 消息类型：提取 role 和 content
        const role = normalizeRole('codex', item.role || 'unknown');
        const text = extractText(item.content);
        if (!text) continue;

        processedTexts.add(text);
        results.push({
          role,
          content: text,
          toolCalls: null,
          toolCallId: null,
          timestamp: entry.timestamp || sessionTimestamp,
        });
      } else if (itemType === 'function_call') {
        // 函数调用：提取 name 和 arguments
        if (!item.name) continue;

        results.push({
          role: 'assistant',
          content: null,
          toolCalls: JSON.stringify({ name: item.name, arguments: item.arguments || {} }),
          toolCallId: item.id || item.conversation_item_id || null,
          timestamp: entry.timestamp || sessionTimestamp,
        });
      } else if (itemType === 'function_call_output') {
        // 函数调用输出：提取 tool_use_id 和 output
        const output = extractText(item.output);
        results.push({
          role: 'tool',
          content: output || null,
          toolCalls: null,
          toolCallId: item.conversation_item_id || item.tool_use_id || null,
          timestamp: entry.timestamp || sessionTimestamp,
        });
      }
      // 其他 response_item 类型跳过
    } else if (entry.type === 'event_msg') {
      // 事件消息：作为补充消息，去重后添加
      const msgType = entry.msg_type || entry.role;
      const text = extractText(entry.content || entry.message?.content);

      if (!text) continue;
      // 如果该文本已被 response_item 处理过，跳过
      if (processedTexts.has(text)) continue;

      // event_msg 作为 user 或 assistant 消息
      let role = 'user';
      if (msgType === 'agent_message' || msgType === 'assistant') {
        role = 'assistant';
      } else if (msgType === 'user_message' || msgType === 'user') {
        role = 'user';
      }

      results.push({
        role: normalizeRole('codex', role),
        content: text,
        toolCalls: null,
        toolCallId: null,
        timestamp: entry.timestamp || sessionTimestamp,
      });
    }
  }

  return results;
}

/**
 * 解析 Codex 会话文件，同时返回 session 元数据。
 * @param {string} filePath - 会话文件路径
 * @returns {{ sessionId: string|null, cwd: string|null, timestamp: string|null, messages: Array<{ role: string, content: string|null, toolCalls: string|null, toolCallId: string|null, timestamp: string|null }> }}
 */
export function parseSessionFileWithMeta(filePath) {
  const entries = readJsonl(filePath);

  let sessionId = null;
  let sessionCwd = null;
  let sessionTimestamp = null;

  for (const entry of entries) {
    if (entry.type === 'session_meta') {
      sessionId = entry.id || null;
      sessionCwd = entry.cwd || null;
      sessionTimestamp = entry.timestamp || null;
      break;
    }
  }

  const messages = parseSessionFile(filePath);

  return { sessionId, cwd: sessionCwd, timestamp: sessionTimestamp, messages };
}
