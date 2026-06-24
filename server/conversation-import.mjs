/**
 * 对话来源同步引擎。
 * 首次升级使用全量原子 reconcile，后续按 source_file 替换，失败文件保留旧数据。
 */

import { readdirSync, statSync, watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { listConversationSources } from './database.mjs';
import { detectFormat, parseSourceFile } from './conversation-parser.mjs';
import { mapSourceError } from './errors.mjs';

class SourceSyncError extends Error {
  constructor(code, message, retryable, details = {}) {
    super(message);
    this.name = 'SourceSyncError';
    this.code = code;
    this.retryable = retryable;
    this.contextId = details.contextId || null;
    this.details = details;
  }
}

function listJsonlFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...listJsonlFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path);
  }
  return files.sort();
}

export function classifySourceError(error) {
  if (error instanceof SourceSyncError) return error;
  const envelope = mapSourceError(error);
  if (envelope.code !== 'PARSE_ERROR') return new SourceSyncError(envelope.code, envelope.message, envelope.retryable, { contextId: envelope.contextId });
  if (error?.code === 'UNSUPPORTED_ROLE') {
    return new SourceSyncError('PARSE_ERROR', '无法解析对话来源', true, { contextId: envelope.contextId });
  }
  return new SourceSyncError('PARSE_ERROR', envelope.message, true, { contextId: envelope.contextId });
}

function runOpenCodeWorker({ source, targetDbPath, previousRevision }) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./opencode-sync-worker.mjs', import.meta.url), {
      // stdin/eval smoke 可能带 --input-type，该参数不能传给文件型 Worker。
      execArgv: process.execArgv.filter((arg) => !arg.startsWith('--input-type')),
      workerData: {
        sourcePath: source.path,
        targetDbPath,
        sourceId: source.id,
        needsReconcile: Boolean(source.needs_reconcile),
        previousRevision,
      },
    });
    let settled = false;
    worker.once('message', (message) => {
      settled = true;
      if (message.ok) resolve(message.result);
      else reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (!settled && code !== 0) reject(Object.assign(new Error('OpenCode 同步 worker 异常退出'), { code: 'WORKER_EXIT' }));
    });
  });
}

function runJsonlWorker({ source, targetDbPath }) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./jsonl-sync-worker.mjs', import.meta.url), {
      execArgv: process.execArgv.filter((arg) => !arg.startsWith('--input-type')),
      workerData: { source, targetDbPath },
    });
    let settled = false;
    worker.once('message', (message) => {
      settled = true;
      if (message.ok) resolve(message.result);
      else reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (!settled && code !== 0) reject(Object.assign(new Error('JSONL 同步 worker 异常退出'), { code: 'WORKER_EXIT' }));
    });
  });
}

async function parseFile(source, filePath) {
  if (!detectFormat(filePath)) {
    throw new SourceSyncError('PARSE_ERROR', '无法识别对话文件格式', true, { filePath });
  }
  const sessions = parseSourceFile(filePath, source.agent_type);
  if (sessions.length === 0) {
    throw new SourceSyncError('PARSE_ERROR', '对话文件没有可用会话', true, { filePath });
  }
  // 快照路径只用于解析，持久化必须回写真实来源路径，避免临时目录泄漏到历史记录。
  const normalizedSessions = sessions.map((session) => ({ ...session, sourceFile: filePath }));
  return { sessions: normalizedSessions };
}

function insertSessions(db, sourceId, sessions) {
  const insertSession = db.prepare(`
    INSERT INTO conversation_sessions
      (session_key, source_id, native_session_id, cwd, title, started_at, ended_at,
       source_file, message_count, metadata, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const insertMessage = db.prepare(`
    INSERT INTO conversations
      (id, source_id, session_id, session_key, native_message_id, message_index, role,
       content, tool_calls, tool_call_id, metadata, user_text, ended_at, cwd, source_file)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let inserted = 0;
  for (const session of sessions) {
    // 原生 session ID 只在单个来源内唯一，持久化键必须包含 sourceId 防止多配置冲突。
    const persistedSessionKey = `${sourceId}:${session.sessionKey}`;
    insertSession.run(
      persistedSessionKey,
      sourceId,
      session.nativeSessionId,
      session.cwd,
      session.title,
      session.startedAt,
      session.endedAt,
      session.sourceFile,
      session.messages.length,
      null,
    );
    for (const message of session.messages) {
      // 来源 ID、原生消息 ID 和顺序共同构成稳定 ID，避免文件重扫制造重复消息。
      const id = `${sourceId}:${message.nativeMessageId}`;
      insertMessage.run(
        id,
        sourceId,
        session.nativeSessionId,
        persistedSessionKey,
        message.nativeMessageId,
        message.messageIndex,
        message.role,
        message.content,
        message.toolCalls,
        message.toolCallId,
        message.metadata,
        message.role === 'user' ? message.content : null,
        message.timestamp,
        session.cwd,
        session.sourceFile,
      );
      inserted += 1;
    }
  }
  return inserted;
}

function replaceSourceData(db, source, parsedByFile, scannedFiles) {
  return db.transaction(() => {
    const before = db.prepare('SELECT COUNT(*) AS count FROM conversations WHERE source_id = ?').get(source.id).count;
    if (source.needs_reconcile) {
      db.prepare('DELETE FROM conversations WHERE source_id = ?').run(source.id);
      db.prepare('DELETE FROM conversation_sessions WHERE source_id = ?').run(source.id);
    } else {
      for (const filePath of parsedByFile.keys()) {
        db.prepare('DELETE FROM conversations WHERE source_id = ? AND source_file = ?').run(source.id, filePath);
        db.prepare('DELETE FROM conversation_sessions WHERE source_id = ? AND source_file = ?').run(source.id, filePath);
      }
      // 完整目录扫描时，已消失文件的数据也必须移除；失败但仍存在的文件不在删除集合中。
      const existingFiles = db.prepare('SELECT DISTINCT source_file FROM conversation_sessions WHERE source_id = ?').all(source.id);
      for (const row of existingFiles) {
        if (row.source_file && !scannedFiles.has(row.source_file)) {
          db.prepare('DELETE FROM conversations WHERE source_id = ? AND source_file = ?').run(source.id, row.source_file);
          db.prepare('DELETE FROM conversation_sessions WHERE source_id = ? AND source_file = ?').run(source.id, row.source_file);
        }
      }
    }

    let inserted = 0;
    for (const sessions of parsedByFile.values()) inserted += insertSessions(db, source.id, sessions);
    const after = db.prepare('SELECT COUNT(*) AS count FROM conversations WHERE source_id = ?').get(source.id).count;
    return { inserted, deleted: Math.max(0, before + inserted - after) };
  })();
}

function updateSourceSuccess(db, sourceId, messageCount, now, metadata = null) {
  db.prepare(`
    UPDATE conversation_sources
    SET status = 'active', sync_state = 'active', needs_reconcile = 0,
        record_count = ?, last_synced_at = ?, last_success_at = ?,
        last_error_code = NULL, last_error_message = NULL, last_error_at = NULL,
        metadata = COALESCE(?, metadata)
    WHERE id = ?
  `).run(messageCount, now, now, metadata, sourceId);
}

function updateSourceError(db, sourceId, error, now) {
  db.prepare(`
    UPDATE conversation_sources
    SET status = 'error', sync_state = 'error', last_error_code = ?,
        last_error_message = ?, last_error_at = ?
    WHERE id = ?
  `).run(error.code, error.message, now, sourceId);
}

export async function performJsonlSourceSync(db, source) {
  const failedFiles = [];
  const parsedByFile = new Map();
  let unrecognizedFailures = 0;
  try {
    const sourceStat = statSync(source.path);
    const files = sourceStat.isDirectory() ? listJsonlFiles(source.path) : [source.path];
    if (files.length === 0) throw new SourceSyncError('PARSE_ERROR', '对话来源中没有可解析文件', true);
    const scannedFiles = new Set(files);
    for (const filePath of files) {
      try {
        const parsed = await parseFile(source, filePath);
        parsedByFile.set(filePath, parsed.sessions);
      } catch (error) {
        const classified = classifySourceError(error);
        failedFiles.push({ filePath, code: classified.code });
        // "无法识别对话文件格式" 意味着该 JSONL 不是 Agent 会话（如 fixtures/全局索引），
        // 不应阻断其它文件入库；needs_reconcile 首次全量也只跳过、不抛。
        const unrecognized = classified.code === 'PARSE_ERROR'
          && /无法识别对话文件格式/.test(classified.message);
        if (unrecognized) unrecognizedFailures += 1;
        if (source.needs_reconcile && !unrecognized) throw classified;
      }
    }
    const counts = replaceSourceData(db, source, parsedByFile, scannedFiles);
    const messageCount = db.prepare('SELECT COUNT(*) AS count FROM conversations WHERE source_id = ?').get(source.id).count;
    const now = new Date().toISOString();
    if (failedFiles.length > 0) {
      // 全部失败都是"无法识别对话文件格式"且至少有一个文件成功入库时，
      // 这些 JSONL 是混入目录的 fixtures / 全局索引，不应让 source 整体标 error。
      const onlyUnrecognized = unrecognizedFailures === failedFiles.length;
      const hasSuccessfulInsert = parsedByFile.size > 0 && messageCount > 0;
      if (onlyUnrecognized && hasSuccessfulInsert) {
        updateSourceSuccess(db, source.id, messageCount, now);
        return { sourceId: source.id, state: 'active', ...counts, updated: 0, failedFiles, lastSuccessAt: now };
      }
      const partial = new SourceSyncError('PARSE_ERROR', '部分对话文件同步失败', true);
      updateSourceError(db, source.id, partial, now);
      return { sourceId: source.id, state: 'error', ...counts, updated: 0, failedFiles, error: { code: partial.code, message: partial.message, retryable: partial.retryable, contextId: partial.contextId } };
    }
    updateSourceSuccess(db, source.id, messageCount, now);
    return { sourceId: source.id, state: 'active', ...counts, updated: 0, failedFiles, lastSuccessAt: now };
  } catch (error) {
    const classified = classifySourceError(error);
    const now = new Date().toISOString();
    updateSourceError(db, source.id, classified, now);
    return { sourceId: source.id, state: 'error', inserted: 0, updated: 0, deleted: 0, failedFiles,
      error: { code: classified.code, message: classified.message, retryable: classified.retryable, contextId: classified.contextId } };
  }
}

export function createImportEngine({ db } = {}) {
  if (!db) throw new Error('createImportEngine 需要提供 db 实例');
  const sourceSyncs = new Map();
  let schedulerTimer = null;
  let watchers = [];

  async function performSync(sourceId) {
    const source = db.prepare(`
      SELECT id, path, agent_type, enabled, needs_reconcile, metadata
      FROM conversation_sources WHERE id = ?
    `).get(sourceId);
    if (!source) {
      return {
        sourceId,
        state: 'error',
        inserted: 0,
        updated: 0,
        deleted: 0,
        failedFiles: [],
        error: { code: 'SOURCE_NOT_FOUND', message: '对话来源不存在', retryable: false, contextId: null },
      };
    }

    const attemptedAt = new Date().toISOString();
    db.prepare("UPDATE conversation_sources SET sync_state = 'syncing', last_attempt_at = ? WHERE id = ?")
      .run(attemptedAt, sourceId);
    const failedFiles = [];
    try {
      statSync(source.path);

      if (source.agent_type === 'opencode') {
        let previousRevision = null;
        try { previousRevision = JSON.parse(source.metadata || '{}').lastMessageTime || null; } catch { /* 损坏元数据触发全量替换 */ }
        const result = await runOpenCodeWorker({ source, targetDbPath: db.name, previousRevision });
        if (result.skipped) {
          const now = new Date().toISOString();
          const messageCount = db.prepare('SELECT COUNT(*) AS count FROM conversations WHERE source_id = ?').get(sourceId).count;
          updateSourceSuccess(db, sourceId, messageCount, now);
          result.lastSuccessAt = now;
        }
        return {
          sourceId,
          state: 'active',
          inserted: result.inserted,
          updated: 0,
          deleted: result.deleted,
          failedFiles,
          lastSuccessAt: result.lastSuccessAt || attemptedAt,
          skipped: result.skipped,
        };
      }
      return await runJsonlWorker({ source, targetDbPath: db.name });
    } catch (error) {
      const classified = classifySourceError(error);
      const now = new Date().toISOString();
      // updateSourceError 自身也可能因 db 锁竞争抛 SQLITE_BUSY（worker 大事务期间主线程争用）。
      // 这种二次失败不应再冒泡成 unhandledRejection；降级为 console.error，让 syncSource 仍能返回 error 结果。
      try {
        updateSourceError(db, sourceId, classified, now);
      } catch (secondary) {
        console.error('[conversation-import] updateSourceError failed after primary error', {
          sourceId,
          primaryCode: classified.code,
          secondaryCode: secondary?.code,
          secondaryMessage: secondary instanceof Error ? secondary.message : String(secondary),
        });
      }
      return {
        sourceId,
        state: 'error',
        inserted: 0,
        updated: 0,
        deleted: 0,
        failedFiles,
        error: { code: classified.code, message: classified.message, retryable: classified.retryable, contextId: classified.contextId },
      };
    }
  }

  function syncSource(sourceId) {
    if (sourceSyncs.has(sourceId)) return sourceSyncs.get(sourceId);
    const promise = performSync(sourceId).finally(() => sourceSyncs.delete(sourceId));
    sourceSyncs.set(sourceId, promise);
    return promise;
  }

  async function syncAll() {
    const results = [];
    for (const source of listConversationSources()) {
      if (!source.enabled) continue;
      results.push(await syncSource(source.id));
    }
    return results;
  }

  function startScheduler(intervalMs = 3_600_000) {
    if (schedulerTimer) return;
    schedulerTimer = setInterval(() => void syncAll(), intervalMs);
    schedulerTimer.unref?.();
  }

  function startWatcher() {
    if (watchers.length > 0) return;
    const debounce = new Map();
    for (const source of listConversationSources()) {
      const directory = dirname(source.path);
      try {
        const watcher = watch(directory, { persistent: false }, () => {
          clearTimeout(debounce.get(source.id));
          debounce.set(source.id, setTimeout(() => void syncSource(source.id), 500));
        });
        watchers.push(watcher);
      } catch {
        // 监听失败不改变来源状态；真实同步会返回可诊断错误。
      }
    }
  }

  function stop() {
    if (schedulerTimer) clearInterval(schedulerTimer);
    schedulerTimer = null;
    for (const watcher of watchers) watcher.close();
    watchers = [];
  }

  return { syncSource, syncAll, startScheduler, startWatcher, stop };
}
