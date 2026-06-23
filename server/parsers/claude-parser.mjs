/**
 * Claude Code 对话历史解析器
 *
 * 支持两种文件：
 *   1. ~/.claude/history.jsonl — 全局输入索引（每行一条用户输入）
 *   2. ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl — 会话详情
 *
 * history.jsonl 每行格式：
 *   { "display": "用户输入", "sessionId": "...", "timestamp": 1234567890000, "project": { "path": "..." } }
 *
 * 会话文件格式：
 *   每行一个 JSON 对象，type 字段标识消息类型：user / assistant / tool_use / tool_result
 *   timestamp 字段为毫秒时间戳。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
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
 * 毫秒时间戳转 ISO 8601 字符串。
 * @param {number} ms - 毫秒时间戳
 * @returns {string} ISO 8601 字符串
 */
function msToIso(ms) {
  if (!ms || typeof ms !== 'number') return null;
  return new Date(ms).toISOString();
}

/**
 * 解析 Claude Code 全局输入索引文件（~/.claude/history.jsonl）。
 *
 * 每行提取 display（用户输入）、sessionId、timestamp（毫秒转 ISO）、
 * project.path（作为 cwd）。
 *
 * @param {string} filePath - history.jsonl 文件路径
 * @returns {Array<{ sessionId: string, userText: string, timestamp: string|null, cwd: string|null }>} 解析结果
 */
export function parseGlobalIndex(filePath) {
  const entries = readJsonl(filePath);
  const results = [];

  for (const entry of entries) {
    // 必须包含 display 字段才视为用户输入记录
    if (!entry.display || typeof entry.display !== 'string') continue;

    const project = entry.project;
    const cwd = project && typeof project.path === 'string' ? project.path : null;

    results.push({
      sessionId: entry.sessionId || null,
      userText: entry.display,
      timestamp: msToIso(entry.timestamp),
      cwd,
    });
  }

  return results;
}

/**
 * 从 user/assistant 消息的 content 数组中提取纯文本。
 * content 是数组，可能包含 {type: 'text', text: '...'} 或 {type: 'tool_use', ...}。
 * @param {Array} content - 消息内容数组
 * @returns {string} 拼接后的纯文本
 */
function extractTextFromContent(content) {
  if (!Array.isArray(content)) {
    if (typeof content === 'string') return content;
    return '';
  }
  return content
    .filter((item) => item && item.type === 'text' && item.text)
    .map((item) => item.text)
    .join('\n');
}

/**
 * 解析 Claude Code 会话 JSONL 文件。
 *
 * 每行一个 JSON 对象，按 type 字段分发：
 *   - user: 提取 content 中的 text 作为用户消息
 *   - assistant: 提取 content 中的 text 作为助手回复
 *   - tool_use: 提取 name 和 input 作为工具调用
 *   - tool_result: 提取 tool_use_id 和 content 作为工具结果
 *
 * @param {string} filePath - 会话 JSONL 文件路径
 * @returns {Array<{ role: string, content: string|null, toolCalls: string|null, toolCallId: string|null, timestamp: string|null }>} 解析结果
 */
export function parseSessionFile(filePath) {
  const entries = readJsonl(filePath);
  if (entries.some((entry) => typeof entry?.display === 'string')) {
    // history.jsonl 没有 type/message 包装，直接转换为用户消息。
    return entries
      .filter((entry) => typeof entry?.display === 'string' && entry.display.trim())
      .map((entry) => ({
        role: 'user',
        content: entry.display,
        toolCalls: null,
        toolCallId: null,
        timestamp: msToIso(entry.timestamp),
      }));
  }
  const results = [];

  for (const entry of entries) {
    if (!entry || !entry.type) continue;

    const timestamp = msToIso(entry.timestamp);
    const type = entry.type;

    if (type === 'user') {
      // 用户消息：提取 content 数组中的 text
      const text = extractTextFromContent(entry.message?.content);
      if (text) {
        results.push({
          role: normalizeRole('claude', 'user'),
          content: text,
          toolCalls: null,
          toolCallId: null,
          timestamp,
        });
      }
    } else if (type === 'assistant') {
      // 助手消息：提取 content 数组中的 text
      const text = extractTextFromContent(entry.message?.content);
      if (text) {
        results.push({
          role: normalizeRole('claude', 'assistant'),
          content: text,
          toolCalls: null,
          toolCallId: null,
          timestamp,
        });
      }
    } else if (type === 'tool_use') {
      // 工具调用：提取 name 和 input
      if (entry.name) {
        results.push({
          role: normalizeRole('claude', 'tool_use'),
          content: null,
          toolCalls: JSON.stringify({ name: entry.name, input: entry.input || {} }),
          toolCallId: entry.id || null,
          timestamp,
        });
      }
    } else if (type === 'tool_result') {
      // 工具结果：提取 tool_use_id 和 content
      const resultContent = extractTextFromContent(entry.content);
      results.push({
        role: normalizeRole('claude', 'tool_result'),
        content: resultContent || null,
        toolCalls: null,
        toolCallId: entry.tool_use_id || null,
        timestamp,
      });
    }
    // 其他类型（如 summary）跳过
  }

  return results;
}

/**
 * 解析 Claude JSONL 文件并保留会话归属元数据（sessionId/cwd/title/timestamp）。
 * @param {string} filePath
 * @returns {{sessionId: string, cwd: string|null, title: string|null,
 *           timestamp: string|null, messages: Array<...>}}
 */
export function parseSessionFileWithMeta(filePath) {
  const entries = readJsonl(filePath);
  const first = entries.find((entry) => entry && typeof entry === 'object') || {};
  return {
    sessionId: first.sessionId || first.session_id || basename(filePath, '.jsonl'),
    cwd: first.cwd || first.project?.path || null,
    title: first.summary || first.display || null,
    timestamp: msToIso(first.timestamp) || first.timestamp || null,
    messages: parseSessionFile(filePath),
  };
}

/**
 * 解析项目目录下的所有会话文件。
 * 辅助函数：扫描 projects/<encoded-path> 目录中的 .jsonl 文件。
 *
 * @param {string} projectsDir - projects 目录路径
 * @returns {Map<string, object[]>} sessionId → 解析结果映射
 */
export function parseAllSessionFiles(projectsDir) {
  const sessionMap = new Map();

  if (!existsSync(projectsDir)) return sessionMap;

  const entries = readdirSync(projectsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sessionDir = resolve(projectsDir, entry.name);
    const files = readdirSync(sessionDir, { withFileTypes: true });
    for (const file of files) {
      if (!file.name.endsWith('.jsonl')) continue;
      const sessionId = file.name.replace(/\.jsonl$/, '');
      const filePath = resolve(sessionDir, file.name);
      try {
        const messages = parseSessionFile(filePath);
        sessionMap.set(sessionId, messages);
      } catch {
        // 单个文件失败不影响其他文件
      }
    }
  }

  return sessionMap;
}
