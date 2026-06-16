/**
 * Path history store with tombstone events
 *
 * 设计 C-002：
 *   - 数据：data/path-history.jsonl，事件类型 union {type:'use'|'delete'|'clear', path?, at}
 *   - 折叠：读取时按 path 聚合，clear 之后的事件生效，delete 后再有 use 视为恢复
 *   - 列出项：useCount > 0 且 lastUsedAt > deletedAt（或 deletedAt === null）
 *   - 串行化：所有 append 走 withLock → proper-lockfile advisory lock
 *   - exists：list 时实时 fs.stat，无缓存
 *
 * 校验：path 合法性走 server/validation.mjs.validatePath
 */

import {
  appendFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  statSync,
} from 'node:fs';
import { join, basename, resolve } from 'node:path';
import lockfile from 'proper-lockfile';
import { validatePath, checkDirectoryExists } from './validation.mjs';

function getDataDir() {
  return process.env.DATA_DIR || join(process.cwd(), 'data');
}

function getJsonlFile() {
  return join(getDataDir(), 'path-history.jsonl');
}

function ensureDataDir() {
  const dataDir = getDataDir();
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
}

/**
 * Ensure the JSONL file exists (proper-lockfile requires it).
 * Idempotent; safe to call inside withLock.
 */
function ensureFile() {
  ensureDataDir();
  const file = getJsonlFile();
  if (!existsSync(file)) {
    appendFileSync(file, '', 'utf-8');
  }
  return file;
}

/**
 * Acquire advisory lock and run fn; always release.
 * 串行化所有写操作（C-002 要求）。
 *
 * 实现：进程内 Promise 链排队 → 避免 proper-lockfile 高并发饥饿；
 * 跨进程 advisory lock（proper-lockfile）作为兜底，防止多 Node 进程同时写入。
 */
let chain = Promise.resolve();
function withLock(fn) {
  const next = chain.then(async () => {
    const file = ensureFile();
    const release = await lockfile.lock(file, {
      retries: { retries: 20, minTimeout: 50, maxTimeout: 500, factor: 1.5 },
      stale: 5000,
    });
    try {
      return await fn();
    } finally {
      try { await release(); } catch { /* lock may have been broken */ }
    }
  });
  // chain 永不 reject；不让一个失败的任务影响后续任务
  chain = next.catch(() => {});
  return next;
}

function appendEventSync(event) {
  ensureDataDir();
  const line = JSON.stringify(event) + '\n';
  appendFileSync(getJsonlFile(), line, 'utf-8');
}

function loadEvents() {
  const jsonlFile = getJsonlFile();
  if (!existsSync(jsonlFile)) return [];
  try {
    const content = readFileSync(jsonlFile, 'utf-8');
    const lines = content.split('\n').filter((line) => line.trim());
    return lines
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Fold events into a path map with explicit deletedAt.
 *   - clear: clear map, set clearTimestamp; events at <= clearTimestamp are ignored
 *   - delete: set entry.deletedAt = event.at (create entry if missing)
 *   - use: if entry.deletedAt && event.at <= entry.deletedAt, ignore; else increment useCount, set lastUsedAt
 */
function foldPaths(events) {
  const pathMap = new Map();
  let clearTimestamp = null;

  for (const event of events) {
    if (event.type === 'clear') {
      clearTimestamp = event.at;
      pathMap.clear();
      continue;
    }
    if (clearTimestamp && event.at <= clearTimestamp) {
      continue;
    }

    if (event.type === 'use') {
      let entry = pathMap.get(event.path);
      if (!entry) {
        entry = {
          path: event.path,
          displayName: basename(event.path),
          deletedAt: null,
          useCount: 0,
          lastUsedAt: null,
        };
        pathMap.set(event.path, entry);
      }
      if (entry.deletedAt && event.at <= entry.deletedAt) {
        continue;
      }
      entry.useCount += 1;
      entry.lastUsedAt = event.at;
    } else if (event.type === 'delete') {
      let entry = pathMap.get(event.path);
      if (!entry) {
        entry = {
          path: event.path,
          displayName: basename(event.path),
          deletedAt: null,
          useCount: 0,
          lastUsedAt: null,
        };
        pathMap.set(event.path, entry);
      }
      entry.deletedAt = event.at;
    }
  }
  return Array.from(pathMap.values());
}

function isVisible(entry) {
  if (entry.useCount <= 0) return false;
  if (!entry.lastUsedAt) return false;
  if (entry.deletedAt && entry.lastUsedAt <= entry.deletedAt) return false;
  return true;
}

function checkExists(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

export async function validateAndSave({ path }) {
  const v = validatePath(path);
  if (!v.ok) {
    const err = new Error(v.message);
    err.code = v.code;
    throw err;
  }
  const exists = checkDirectoryExists(path);
  if (!exists.ok) {
    const err = new Error(exists.message);
    err.code = exists.code;
    throw err;
  }

  const resolvedPath = exists.resolved;
  return withLock(async () => {
    appendEventSync({
      type: 'use',
      path: resolvedPath,
      at: new Date().toISOString(),
    });
    return {
      item: {
        path: resolvedPath,
        displayName: exists.displayName,
        lastUsedAt: new Date().toISOString(),
        useCount: 1,
        exists: true,
      },
    };
  });
}

export async function list({ limit = 50 } = {}) {
  const events = loadEvents();
  const folded = foldPaths(events);
  let items = folded
    .filter(isVisible)
    .map((item) => ({ ...item, exists: checkExists(item.path) }));
  items.sort((a, b) => new Date(b.lastUsedAt) - new Date(a.lastUsedAt));
  if (limit > 50) limit = 50;
  if (limit < 0) limit = 0;
  items = items.slice(0, limit);
  return { items };
}

export async function deletePath({ path }) {
  const v = validatePath(path);
  if (!v.ok) {
    const err = new Error(v.message);
    err.code = v.code;
    throw err;
  }
  const resolvedPath = resolve(path);
  return withLock(async () => {
    appendEventSync({
      type: 'delete',
      path: resolvedPath,
      at: new Date().toISOString(),
    });
    return { ok: true };
  });
}

export async function clearAll() {
  return withLock(async () => {
    appendEventSync({ type: 'clear', at: new Date().toISOString() });
    return { ok: true };
  });
}

export default {
  validateAndSave,
  list,
  deletePath,
  clearAll,
};
