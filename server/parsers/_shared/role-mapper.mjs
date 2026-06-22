/**
 * 角色映射共享模块
 *
 * 职责：
 *   - normalizeRole(agentType, rawRole)：将各 parser 的原始 role 映射到统一枚举
 *   - recordFromMessage({agentType, message, cwd, sessionId})：从消息构建数据库记录
 *
 * 统一枚举：user / assistant / system / tool
 */

// ===================== 角色映射表 =====================

const ROLE_MAP = {
  claude: {
    user: 'user',
    assistant: 'assistant',
    tool_use: 'tool',
    tool_result: 'tool',
    developer: 'system',
  },
  codex: {
    user: 'user',
    assistant: 'assistant',
    developer: 'system',
    tool: 'tool',
  },
  pi: {
    user: 'user',
    assistant: 'assistant',
    toolResult: 'tool',
    tool: 'tool',
    system: 'system',
  },
  opencode: {
    user: 'user',
    assistant: 'assistant',
    system: 'system',
    tool: 'tool',
  },
};

/**
 * 将原始 role 映射到统一枚举。
 * @param {string} agentType - agent 类型（claude / codex / pi / opencode）
 * @param {string} rawRole - 原始 role 字符串
 * @returns {'user' | 'assistant' | 'system' | 'tool'} 统一枚举
 */
export function normalizeRole(agentType, rawRole) {
  const map = ROLE_MAP[agentType];
  if (!map) return rawRole; // 未知 agent_type 透传
  return map[rawRole] || rawRole;
}

/**
 * 从消息构建数据库记录。
 * @param {{ agentType: string, message: { role: string, content: string|null, toolCalls?: string|null, toolCallId?: string|null, timestamp?: string|null }, cwd?: string|null, sessionId?: string|null }} params
 * @returns {{ role: string, content: string|null, toolCalls: string|null, toolCallId: string|null, metadata: string|null, endedAt: string|null }} 数据库记录
 */
export function recordFromMessage({ agentType, message, cwd = null, sessionId = null }) {
  const role = normalizeRole(agentType, message.role);
  const content = message.content ? JSON.stringify({ text: message.content }) : null;

  return {
    role,
    content,
    toolCalls: message.toolCalls || null,
    toolCallId: message.toolCallId || null,
    metadata: JSON.stringify({
      timestamp: message.timestamp || null,
      cwd: cwd || null,
      sessionId: sessionId || null,
      agentType,
    }),
    endedAt: message.timestamp || null,
  };
}
