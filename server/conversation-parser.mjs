/**
 * 对话历史格式检测器与解析调度器
 *
 * 职责：
 *   1. detectFormat(filePath) — 检测文件格式（claude / pi / codex / opencode）
 *   2. parseConversationFile(filePath, format) — 分发到专用解析器
 *   3. registerParser(format, parser) — 注册自定义解析器（扩展用）
 *
 * 格式检测策略：读取首行 JSON，根据特征字段判断 agent 类型。
 */

import { readFileSync } from 'node:fs';
import { parseSessionFile as parseClaudeSession } from './parsers/claude-parser.mjs';
import { parseSessionFileWithMeta as parseClaudeSessionWithMeta } from './parsers/claude-parser.mjs';
import { parseSessionFile as parsePiSession } from './parsers/pi-parser.mjs';
import { parseSessionFileWithMeta as parsePiSessionWithMeta } from './parsers/pi-parser.mjs';
import { parseSessionFile as parseCodexSession } from './parsers/codex-parser.mjs';
import { parseSessionFileWithMeta as parseCodexSessionWithMeta } from './parsers/codex-parser.mjs';
import { parseSessionFile as parseOpencodeSession } from './parsers/opencode-parser.mjs';
import { parseSessionFilesWithMeta as parseOpencodeSessionsWithMeta } from './parsers/opencode-parser.mjs';
import { createSessionContract } from './parsers/_shared/session-contract.mjs';

// ===================== 解析器注册表 =====================

/** @type {Map<string, { parseSessionFile: Function }>} */
const parserRegistry = new Map();

// 注册内置解析器
parserRegistry.set('claude', { parseSessionFile: parseClaudeSession });
parserRegistry.set('pi', { parseSessionFile: parsePiSession });
parserRegistry.set('codex', { parseSessionFile: parseCodexSession });
parserRegistry.set('opencode', { parseSessionFile: parseOpencodeSession });

const metadataParsers = new Map([
  ['claude', (filePath) => [parseClaudeSessionWithMeta(filePath)]],
  ['codex', (filePath) => [parseCodexSessionWithMeta(filePath)]],
  ['pi', (filePath) => [parsePiSessionWithMeta(filePath)]],
  ['opencode', (filePath) => parseOpencodeSessionsWithMeta(filePath)],
]);

// ===================== 格式检测 =====================

// CLAUDE_BRANCH_META_TYPES：Claude Code 在每个会话文件首部写入的元数据行，
// 这些行不含消息正文，但只要它们出现在文件里就足以判定该文件属于 Claude 会话。
const CLAUDE_BRANCH_META_TYPES = new Set([
  'last-prompt',
  'queue-operation',
  'mode',
  'attachment',
  'summary',
  'save-context',
  'ai-title',
  'user-prompt-submit',
  'stop_hook_summary',
  'permission-mode',
  'file-history-snapshot',
  'hook_progress',
  'hook_response',
]);

// CODEX_INDEX_KEYS：Codex 全局索引（session_index.jsonl）使用的字段组合，
// 没有 message 内容，是 Agent 自身的查找表，不属于单个会话文件，应在解析前跳过。
const CODEX_INDEX_KEYS = ['id', 'thread_name', 'updated_at'];

/**
 * SQLite 文件头魔数（前 16 字节中的 ASCII 字符串 "SQLite format 3\0"）。
 * @param {string} filePath - 文件路径
 * @returns {boolean} 是否为 SQLite 文件
 */
function isSqliteFile(filePath) {
  try {
    const fd = readFileSync(filePath, { length: 16, encoding: null });
    // 检查前 16 字节是否以 "SQLite format 3\0" 开头
    return fd.subarray(0, 16).toString('ascii', 0, 15) === 'SQLite format 3';
  } catch {
    return false;
  }
}

/**
 * 读取文件首行 JSON 对象。
 * @param {string} filePath - 文件路径
 * @returns {object|null} 解析后的 JSON 对象，失败返回 null
 */
function readFirstLineJson(filePath) {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const firstLine = content.split('\n').find((line) => line.trim());
    if (!firstLine) return null;
    return JSON.parse(firstLine);
  } catch {
    return null;
  }
}

/**
 * 检测对话文件的格式。
 *
 * 策略：
 *   1. 先检查文件头判断 SQLite（opencode）
 *   2. 再读取首行 JSON，根据特征字段判断：
 *      - 含 `display` + `project` → 'claude'
 *      - `type: "session"` + `version: 3` → 'pi'
 *      - `type: "session_meta"` → 'codex'
 *      - `type` 属于 Claude 会话元数据行（last-prompt/queue-operation/mode 等） → 'claude'
 *      - `id` + `thread_name` + `updated_at` → 'codex'（Codex 全局索引）
 *      - 含 `type` + `message.role` → 'claude'
 *      - 含 `type` + `message.role` + `parentId` → 'pi'
 *   3. 无法识别 → null
 *
 * @param {string} filePath - 文件路径
 * @returns {'claude' | 'pi' | 'codex' | 'opencode' | null} 检测到的格式，无法识别返回 null
 */
export function detectFormat(filePath) {
  // 1. 检查 SQLite 文件（opencode 预留）
  if (isSqliteFile(filePath)) {
    return 'opencode';
  }

  // 2. 读取首行 JSON
  const firstLine = readFirstLineJson(filePath);
  if (!firstLine) return null;

  // 3. Claude Code 格式：含 display + project 字段
  if (firstLine.display && firstLine.project) {
    return 'claude';
  }

  // 4. pi-mono 格式：type === 'session' && version === 3
  if (firstLine.type === 'session' && firstLine.version === 3) {
    return 'pi';
  }

  // 5. Codex 格式：type === 'session_meta'
  if (firstLine.type === 'session_meta') {
    return 'codex';
  }

  // 6. Claude Code 元数据行（last-prompt/queue-operation/mode 等）：仅凭首行 type 即可识别该文件属于 Claude 会话，
  //    claude-parser 会跳过这些非消息条目，只解析 user/assistant/tool 行。
  if (typeof firstLine.type === 'string' && CLAUDE_BRANCH_META_TYPES.has(firstLine.type)) {
    return 'claude';
  }

  // 7. Codex 全局索引（session_index.jsonl）：id + thread_name + updated_at 三字段共现即视为索引文件，
  //    它不是单个会话的 JSONL，应在导入阶段跳过而不是按会话解析。
  if (CODEX_INDEX_KEYS.every((key) => firstLine[key] !== undefined) && !firstLine.type) {
    return 'codex';
  }

  // 8. Claude Code 会话文件：含 type + message.role（非 session/session_meta）
  if (firstLine.type && firstLine.message && firstLine.message.role) {
    return 'claude';
  }

  // 9. pi-mono 会话树 entry：含 type + message.role + parentId
  if (firstLine.type && firstLine.message && firstLine.message.role && firstLine.parentId !== undefined) {
    return 'pi';
  }

  // 10. Claude Code 会话兜底：首行含 sessionId（且不是已识别的其它 Agent 类型），
  //     视为 Claude session，由 parseSessionFile 进一步过滤 message 行。
  if (typeof firstLine.sessionId === 'string' && firstLine.sessionId.length > 0) {
    return 'claude';
  }

  // 无法识别
  return null;
}

// ===================== 解析调度 =====================

/**
 * 解析对话文件，自动检测格式后分发到对应解析器。
 * @param {string} filePath - 文件路径
 * @param {string} [format] - 指定格式（不指定则自动检测）
 * @returns {Array<{ role: string, content: string|null, toolCalls?: string|null, toolCallId?: string|null, timestamp?: string|null }>} 解析结果
 * @throws {Error} 格式不支持或未注册解析器时抛出
 */
export function parseConversationFile(filePath, format) {
  const detectedFormat = format || detectFormat(filePath);
  if (!detectedFormat) {
    throw new Error(`无法识别文件格式: ${filePath}`);
  }

  const parser = parserRegistry.get(detectedFormat);
  if (!parser) {
    throw new Error(`未注册的解析器格式: ${detectedFormat}`);
  }

  return parser.parseSessionFile(filePath);
}

/**
 * 解析来源文件为统一会话数组；导入层只使用此入口，避免再次丢失 session/cwd。
 */
export function parseSourceFile(filePath, format) {
  const actualFormat = format || detectFormat(filePath);
  const parser = metadataParsers.get(actualFormat);
  if (!parser) throw new Error(`未注册会话解析器: ${actualFormat || 'unknown'}`);
  return parser(filePath).map((rawSession) => createSessionContract(
    actualFormat,
    filePath,
    {
      nativeSessionId: rawSession.sessionId,
      cwd: rawSession.cwd,
      title: rawSession.title,
      timestamp: rawSession.timestamp,
      startedAt: rawSession.startedAt,
      endedAt: rawSession.endedAt,
    },
    rawSession.messages,
  ));
}

// ===================== 扩展注册 =====================

/**
 * 注册自定义解析器。
 * 允许外部代码为新的 agent 格式注册解析器。
 *
 * @param {string} format - 格式标识符（如 'opencode'）
 * @param {{ parseSessionFile: (filePath: string) => Array<object>> } parser - 解析器对象
 */
export function registerParser(format, parser) {
  if (!parser || typeof parser.parseSessionFile !== 'function') {
    throw new Error('解析器必须包含 parseSessionFile 函数');
  }
  parserRegistry.set(format, parser);
}

/**
 * 获取已注册的格式列表。
 * @returns {string[]} 格式标识符数组
 */
export function getRegisteredFormats() {
  return Array.from(parserRegistry.keys());
}
