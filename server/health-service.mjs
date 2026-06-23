/**
 * 服务健康检查装配器。
 * 通过注入 getSchemaVersion / getActiveSessions 避免在测试时强依赖真实 DB / PTY。
 * 任何关键依赖不可用都返回 503 + failedChecks，让外部探针能直接据此告警。
 */

import { getDb } from './database.mjs';

// readSourceSummary：汇总对话来源数量与处于 error 状态的数量，供健康检查返回。
function readSourceSummary() {
  try {
    const row = getDb().prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error
      FROM conversation_sources
    `).get();
    return { total: row?.total || 0, error: row?.error || 0 };
  } catch {
    return { total: 0, error: 0 };
  }
}

/**
 * 计算 /api/health 应返回的状态码与 body。
 * 任意注入依赖抛错时进入 not_ready 503；全部就绪时返回 ready 200 + 详细指标。
 * @param {{getSchemaVersion: () => number, getActiveSessions: () => Array<unknown>}} deps
 */
export function getHealthStatus({ getSchemaVersion, getActiveSessions }) {
  const failedChecks = [];
  let schemaVersion = null;
  let activeSessions = 0;

  try {
    schemaVersion = getSchemaVersion();
  } catch {
    failedChecks.push({ code: 'SCHEMA_UNAVAILABLE', message: '数据库 schema 未就绪' });
  }

  try {
    activeSessions = getActiveSessions().length;
  } catch {
    failedChecks.push({ code: 'PTY_MANAGER_UNAVAILABLE', message: '终端管理器未就绪' });
  }

  if (failedChecks.length > 0) {
    return {
      statusCode: 503,
      body: { status: 'not_ready', version: '1.3', failedChecks },
    };
  }

  return {
    statusCode: 200,
    body: {
      status: 'ready',
      version: '1.3',
      schemaVersion,
      activeSessions,
      sourceSummary: readSourceSummary(),
    },
  };
}
