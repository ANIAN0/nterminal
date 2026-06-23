/**
 * 解析器产出的会话契约工具。
 * createSessionContract 把各家 Agent 解析器的原始输出归一为统一的 sessionKey + messages 形态，
 * 并校验 role 集合，非法角色抛 ParserContractError 让同步引擎按文件失败处理。
 */

import { createHash } from 'node:crypto';
import { basename } from 'node:path';

// VALID_ROLES：同步层约定接受的消息角色，避免解析器把任意字符串写入数据库。
const VALID_ROLES = new Set(['user', 'assistant', 'system', 'tool']);

// ParserContractError：解析契约错误，附 code 与 details 便于日志聚合。
export class ParserContractError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ParserContractError';
    this.code = code;
    this.details = details;
  }
}

/**
 * 把单文件解析结果装配为统一 session 契约，补齐 nativeMessageId / messageIndex / 时间字段。
 * @param {string} agentType
 * @param {string} sourceFile
 * @param {{nativeSessionId?: string, sessionId?: string, cwd?: string|null, title?: string|null,
 *          startedAt?: string|null, endedAt?: string|null, timestamp?: string|null}} metadata
 * @param {Array<{nativeMessageId?: string, role: string, content?: string|null, toolCalls?: string|null,
 *                toolCallId?: string|null, timestamp?: string|null, metadata?: string|null}>} rawMessages
 */
export function createSessionContract(agentType, sourceFile, metadata, rawMessages) {
  const fallbackId = basename(sourceFile).replace(/\.[^.]+$/, '')
    || createHash('sha256').update(sourceFile).digest('hex').slice(0, 16);
  const nativeSessionId = metadata.nativeSessionId || metadata.sessionId || fallbackId;
  const messages = rawMessages.map((message, messageIndex) => {
    if (!VALID_ROLES.has(message.role)) {
      throw new ParserContractError('UNSUPPORTED_ROLE', `不支持的消息角色: ${message.role}`, {
        agentType,
        sourceFile,
        messageIndex,
      });
    }
    return {
      nativeMessageId: message.nativeMessageId || `${nativeSessionId}:${messageIndex}`,
      messageIndex,
      role: message.role,
      content: message.content ?? null,
      toolCalls: message.toolCalls ?? null,
      toolCallId: message.toolCallId ?? null,
      timestamp: message.timestamp ?? null,
      metadata: message.metadata ?? null,
    };
  });
  const timestamps = messages.map((message) => message.timestamp).filter(Boolean);

  return {
    sessionKey: `${agentType}:${nativeSessionId}`,
    nativeSessionId,
    cwd: metadata.cwd || null,
    title: metadata.title || null,
    startedAt: metadata.startedAt || metadata.timestamp || timestamps[0] || null,
    endedAt: metadata.endedAt || timestamps.at(-1) || metadata.timestamp || null,
    sourceFile,
    messages,
  };
}
