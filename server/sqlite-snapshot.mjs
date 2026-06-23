/**
 * SQLite 在线快照辅助器。
 * 用 better-sqlite3 的 backup API 在只读视图下把外部 SQLite 拷贝到 tmpdir 临时文件，
 * 调用方在快照上执行只读解析后本模块负责清理。SQLite_BUSY/LOCKED 时会指数退避重试。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';

// delay：把 ms 毫秒的等待包成 Promise，给重试逻辑使用。
function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

// isRetryable：仅 SQLITE_BUSY / SQLITE_LOCKED 这类临时锁冲突允许重试，其他错误立即抛出。
function isRetryable(error) {
  return error?.code === 'SQLITE_BUSY' || error?.code === 'SQLITE_LOCKED';
}

/**
 * 在 SQLite 在线快照上运行 operation，保证源数据库只读不阻塞写入。
 * 失败时按 SQLITE_BUSY/LOCKED 指数退避重试；无论成功失败都会清理 tmpdir 临时目录。
 * @template T
 * @param {string} sourcePath
 * @param {(snapshotPath: string) => Promise<T>} operation
 * @param {{retries?: number, baseDelayMs?: number}} [options]
 * @returns {Promise<T>}
 */
export async function withSqliteSnapshot(sourcePath, operation, options = {}) {
  const retries = options.retries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 50;
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const snapshotDir = mkdtempSync(join(tmpdir(), 'nterminal-opencode-'));
    const snapshotPath = join(snapshotDir, 'snapshot.db');
    let sourceDb;
    try {
      sourceDb = new Database(sourcePath, { readonly: true, fileMustExist: true });
      sourceDb.pragma('busy_timeout = 1000');
      await sourceDb.backup(snapshotPath);
      sourceDb.close();
      sourceDb = null;
      return await operation(snapshotPath);
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === retries) throw error;
      await delay(baseDelayMs * (2 ** (attempt - 1)));
    } finally {
      sourceDb?.close();
      const resolvedDir = resolve(snapshotDir);
      // 临时目录由本函数创建，仍检查父路径以防未来路径拼装回归造成越界删除。
      if (!resolvedDir.startsWith(resolve(tmpdir()))) {
        throw new Error(`快照临时目录越界: ${resolvedDir}`);
      }
      rmSync(resolvedDir, { recursive: true, force: true });
    }
  }
  throw lastError;
}
