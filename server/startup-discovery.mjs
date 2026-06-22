/**
 * 首次启动自动发现默认对话源。
 *
 * 职责：
 *   - 扫描 RT-002 实测的 4 个 agent 默认目录
 *   - 若 conversation_sources 表无对应行则自动 INSERT
 *   - 幂等：多次调用不重复插入
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 4 个 agent 的默认目录配置。
 * @type {Array<{ agentType: string, path: string, label: string }>}
 */
const DEFAULT_SOURCES = [
  {
    agentType: 'claude',
    path: join(homedir(), '.claude'),
    label: 'Claude Code',
  },
  {
    agentType: 'pi',
    path: join(homedir(), '.pi', 'agent', 'sessions'),
    label: 'Pi-mono',
  },
  {
    agentType: 'codex',
    path: join(homedir(), '.codex'),
    label: 'Codex',
  },
  {
    agentType: 'opencode',
    path: join(homedir(), '.local', 'share', 'opencode', 'opencode.db'),
    label: 'OpenCode',
  },
];

/**
 * 发现并创建默认对话源。
 * @param {import('@tursodatabase/database/compat').Database} db - 数据库实例
 */
export function discoverDefaultSources(db) {
  const checkStmt = db.prepare(
    'SELECT COUNT(*) as cnt FROM conversation_sources WHERE agent_type = ?'
  );

  const insertStmt = db.prepare(
    'INSERT INTO conversation_sources (id, path, agent_type, label, status) VALUES (?, ?, ?, ?, ?)'
  );

  for (const source of DEFAULT_SOURCES) {
    const existing = checkStmt.get(source.agentType);
    if (existing.cnt > 0) continue; // 已存在，跳过

    const pathExists = existsSync(source.path);
    const status = pathExists ? 'active' : 'error';
    const id = `${source.agentType}-default`;

    insertStmt.run(id, source.path, source.agentType, source.label, status);
  }
}
