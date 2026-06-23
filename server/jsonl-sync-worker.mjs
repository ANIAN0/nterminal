/**
 * JSONL 同步 worker 入口。
 * 主线程把 source 元数据放在 workerData 中，worker 自行打开目标数据库并完成同步，
 * 通过 parentPort 把结果回传，避免阻塞主事件循环。
 */

import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { performJsonlSourceSync } from './conversation-import.mjs';

// execute：worker 主流程；最终统一通过 postMessage 回传 ok/err 让主线程转为错误包络。
async function execute() {
  const db = new Database(workerData.targetDbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    return await performJsonlSourceSync(db, workerData.source);
  } finally {
    db.close();
  }
}

execute()
  .then((result) => parentPort.postMessage({ ok: true, result }))
  .catch((error) => parentPort.postMessage({
    ok: false,
    error: { code: error?.code || 'PARSE_ERROR', message: error instanceof Error ? error.message : String(error) },
  }));
