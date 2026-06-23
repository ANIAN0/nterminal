/**
 * nterminal 结构化诊断日志写入器。
 * 通过 allowlist 限制可记录字段，避免命令正文、对话正文、请求体、堆栈被意外落盘。
 * 写入采用 appendFileSync + 行分隔 JSON，方便事后脚本聚合。
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// SAFE_LOG_FIELDS：仅放行诊断相关字段，禁止写入正文、路径、堆栈等敏感信息。
const SAFE_LOG_FIELDS = new Set([
  'contextId',
  'code',
  'sourceId',
  'sessionId',
  'tabId',
  'workspaceId',
  'state',
  'status',
  'reason',
  'retryable',
  'errorCode',
  'bytes',
  'textLength',
  'dev',
  'hostname',
  'port',
  'verboseLog',
  'sources',
  'imported',
  'failed',
  'exitCode',
  'signal',
  'cols',
  'rows',
  'method',
  'pathname',
]);

// sanitize：基于 allowlist 过滤 data，未列入 SAFE_LOG_FIELDS 的字段一律丢弃。
function sanitize(data = {}) {
  const safe = {};
  for (const [key, value] of Object.entries(data)) {
    // 日志字段采用 allowlist，避免命令、请求正文、对话正文、路径和堆栈被意外写入。
    if (SAFE_LOG_FIELDS.has(key)) safe[key] = value;
  }
  return safe;
}

/**
 * 创建一个绑定到指定 logDir 的日志写入器。
 * 每次 write 都会同步追加一行 JSON 事件，避免异步丢失导致排障困难。
 * @param {{logDir: string, fileName?: string, consoleEnabled?: boolean}} options
 */
export function createLogger({ logDir, fileName = 'wterm-poc-debug.log', consoleEnabled = true }) {
  const logFile = join(logDir, fileName);
  return {
    write(event, data = {}) {
      const safeData = sanitize(data);
      const line = JSON.stringify({
        at: new Date().toISOString(),
        pid: process.pid,
        event,
        ...safeData,
      });
      mkdirSync(logDir, { recursive: true });
      appendFileSync(logFile, `${line}\n`, 'utf-8');
      if (consoleEnabled) console.log(`[POC] ${event}`, safeData);
    },
  };
}
