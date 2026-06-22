/**
 * 对话历史导入引擎
 *
 * 职责：
 *   - 管理对话源（conversation_sources）的同步
 *   - 增量导入：通过 metadata 记录上次文件大小和行数
 *   - 定时同步 + fs.watch 目录监听
 *   - 错误隔离：单个文件失败不影响整体
 *
 * 增量检测策略：
 *   - JSONL 文件：记录文件大小 + 行数到 source.metadata
 *   - 下次同步时只读取新增行
 */

import { readFileSync, readdirSync, statSync, watch } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { Database } from '@tursodatabase/database/compat';
import {
  listConversationSources,
  insertConversationsBatch,
  updateConversationSourceStatus,
} from './database.mjs';
import {
  detectFormat,
  parseConversationFile,
} from './conversation-parser.mjs';

// ===================== 引擎工厂 =====================

/**
 * 创建导入引擎实例。
 * @param {object} options - 引擎配置
 * @param {Database} options.db - 数据库实例
 * @returns {object} 引擎实例
 */
export function createImportEngine(options) {
  if (!options || !options.db) {
    throw new Error('createImportEngine 需要提供 db 实例');
  }

  const db = options.db;

  // 内部状态
  let schedulerTimer = null;
  let watcher = null;
  let isRunning = false;

  /** 根据来源、文件和消息位置生成稳定 ID，确保重复扫描不会重复写入。 */
  function createRecordId(sourceId, filePath, index, message) {
    return createHash('sha256')
      .update(`${sourceId}\0${filePath}\0${index}\0${message.role}\0${message.content || ''}`)
      .digest('hex');
  }

  /** 递归收集目录中的 JSONL 会话文件。 */
  function listJsonlFiles(root) {
    const files = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = `${root}${root.endsWith('/') || root.endsWith('\\') ? '' : '/'}${entry.name}`;
      if (entry.isDirectory()) files.push(...listJsonlFiles(path));
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path);
    }
    return files;
  }

  /** 返回来源当前实际记录数，避免把本轮新增数误写成累计数。 */
  function countSourceRecords(sourceId) {
    return db.prepare('SELECT COUNT(*) AS total FROM conversations WHERE source_id = ?').get(sourceId)?.total || 0;
  }

  // ===================== 增量元数据 =====================

  /**
   * 从 source 的 metadata JSON 中读取增量状态。
   * 按 agent_type 分支：
   *   - JSONL（claude/pi/codex）：lastFileSize + lastLineCount
   *   - opencode：lastMessageTime（最后一条消息的时间戳）
   * @param {object} source - 对话源记录
   * @returns {{ lastFileSize?: number, lastLineCount?: number, lastMessageTime?: number }}
   */
  function getIncrementalMeta(source) {
    if (!source.metadata) return {};
    try {
      const meta = JSON.parse(source.metadata);
      if (source.agentType === 'opencode') {
        return { lastMessageTime: meta.lastMessageTime || 0 };
      }
      return {
        lastFileSize: meta.lastFileSize || 0,
        lastLineCount: meta.lastLineCount || 0,
      };
    } catch {
      return {};
    }
  }

  /**
   * 保存增量状态到 source.metadata。
   * 按 agent_type 分支写不同 JSON schema。
   * @param {string} sourceId - 源 ID
   * @param {string} agentType - agent 类型
   * @param {number} fileSize - 当前文件大小（JSONL）
   * @param {number} lineCount - 当前行数（JSONL）
   * @param {number} maxTime - 最后消息时间戳（opencode）
   */
  function saveIncrementalMeta(sourceId, agentType, fileSize, lineCount, maxTime) {
    let meta;
    if (agentType === 'opencode') {
      meta = JSON.stringify({ lastMessageTime: maxTime || 0 });
    } else {
      meta = JSON.stringify({ lastFileSize: fileSize || 0, lastLineCount: lineCount || 0 });
    }
    const stmt = db.prepare(`
      UPDATE conversation_sources SET metadata = ? WHERE id = ?
    `);
    stmt.run(meta, sourceId);
  }

  // ===================== 文件元数据 =====================

  /**
   * 获取文件当前大小和行数。
   * @param {string} filePath - 文件路径
   * @returns {{ size: number, lineCount: number }}
   */
  function getFileMeta(filePath) {
    try {
      const stat = statSync(filePath);
      const size = stat.size;

      // 统计行数
      const content = readFileSync(filePath, 'utf-8');
      const lineCount = content.split('\n').length;

      return { size, lineCount };
    } catch {
      return { size: 0, lineCount: 0 };
    }
  }

  // ===================== 核心同步逻辑 =====================

  /**
   * 同步单个对话源。
   *
   * 流程：
   *   1. 读取源文件
   *   2. 检测格式
   *   3. 解析对话
   *   4. 批量插入 conversations 表
   *   5. 更新 last_synced_at, record_count, status
   *
   * @param {string} sourceId - 对话源 ID
   * @returns {{ importedCount: number, skippedCount: number, failedCount: number }} 同步结果统计
   */
  async function syncSource(sourceId) {
    const importedCount = 0;
    const skippedCount = 0;

    // 查询源记录
    const stmt = db.prepare(`
      SELECT id, path, agent_type, metadata, status FROM conversation_sources WHERE id = ?
    `);
    const row = stmt.get(sourceId);

    if (!row) {
      return { importedCount, skippedCount, failedCount: 1 };
    }

    // SQL 使用蛇形字段名，显式映射可避免 agentType 变成 undefined 后误走错误解析分支。
    const source = {
      ...row,
      agentType: row.agent_type,
    };

    const filePath = source.path;
    const agentType = source.agentType;

    // 检查文件是否存在
    let sourceStat;
    try {
      sourceStat = statSync(filePath);
    } catch {
      // 文件不存在，标记错误
      updateConversationSourceStatus(sourceId, {
        lastSyncedAt: new Date().toISOString(),
        recordCount: 0,
        status: 'error',
      });
      return { importedCount, skippedCount: 0, failedCount: 1 };
    }

    if (sourceStat.isDirectory()) {
      try {
        const files = listJsonlFiles(filePath);
        const records = [];
        for (const sourceFile of files) {
          const messages = parseConversationFile(sourceFile, agentType);
          messages.forEach((msg, idx) => records.push({
            id: createRecordId(sourceId, sourceFile, idx, msg),
            sourceId,
            sessionId: null,
            role: msg.role,
            content: msg.content,
            toolCalls: msg.toolCalls || null,
            toolCallId: msg.toolCallId || null,
            metadata: msg.timestamp ? JSON.stringify({ timestamp: msg.timestamp }) : null,
            endedAt: msg.timestamp || null,
          }));
          // 大目录扫描时主动让出事件循环，保证 HTTP/PTY 不被同步解析长期阻塞。
          await new Promise((resolve) => setImmediate(resolve));
        }
        const inserted = insertConversationsBatch(records);
        updateConversationSourceStatus(sourceId, {
          lastSyncedAt: new Date().toISOString(),
          recordCount: countSourceRecords(sourceId),
          status: 'active',
        });
        return { importedCount: inserted, skippedCount: files.length === 0 ? 1 : 0, failedCount: 0 };
      } catch {
        updateConversationSourceStatus(sourceId, {
          lastSyncedAt: new Date().toISOString(),
          recordCount: countSourceRecords(sourceId),
          status: 'error',
        });
        return { importedCount: 0, skippedCount: 0, failedCount: 1 };
      }
    }

    // opencode 走 SQLite 增量路径
    if (agentType === 'opencode') {
      return syncOpencodeSource(source, sourceId, filePath);
    }

    // JSONL 增量路径（claude / pi / codex）
    const { size, lineCount } = getFileMeta(filePath);
    const incremental = getIncrementalMeta(source);

    // 判断是否有增量
    if (size === incremental.lastFileSize && lineCount === incremental.lastLineCount) {
      // 无变化，跳过
      return { importedCount, skippedCount: 1, failedCount: 0 };
    }

    try {
      // 检测格式（使用 agent_type 作为提示，但实际检测文件内容）
      const format = detectFormat(filePath);
      if (!format) {
        throw new Error(`无法识别文件格式: ${filePath}`);
      }

      // 解析对话
      const messages = parseConversationFile(filePath, format);

      // 转换为数据库记录格式
      const records = messages.map((msg, idx) => ({
        id: createRecordId(sourceId, filePath, idx, msg),
        sourceId: sourceId,
        sessionId: null,
        role: msg.role,
        content: msg.content,
        toolCalls: msg.toolCalls || null,
        toolCallId: msg.toolCallId || null,
        metadata: msg.timestamp ? JSON.stringify({ timestamp: msg.timestamp }) : null,
        endedAt: msg.timestamp,
      }));

      // 批量插入
      const inserted = insertConversationsBatch(records);

      // 更新源状态
      updateConversationSourceStatus(sourceId, {
        lastSyncedAt: new Date().toISOString(),
        recordCount: countSourceRecords(sourceId),
        status: 'active',
      });

      // 保存增量元数据
      saveIncrementalMeta(sourceId, agentType, size, lineCount, 0);

      return {
        importedCount: inserted,
        skippedCount: 0,
        failedCount: 0,
      };
    } catch {
      // 解析失败，标记错误
      updateConversationSourceStatus(sourceId, {
        lastSyncedAt: new Date().toISOString(),
        recordCount: 0,
        status: 'error',
      });
      return { importedCount, skippedCount: 0, failedCount: 1 };
    }
  }

  /**
   * 同步 opencode 源（SQLite 增量）。
   * 通过 lastMessageTime 增量获取新消息。
   */
  function syncOpencodeSource(source, sourceId, filePath) {
    const incremental = getIncrementalMeta(source);
    const lastMessageTime = incremental.lastMessageTime || 0;

    try {
      const odb = new Database(filePath, { readonly: true });

      // 获取最新的 time_created 作为增量基准
      const maxTimeRow = odb.prepare('SELECT MAX(time_created) as maxTime FROM message').get();
      const currentMaxTime = maxTimeRow?.maxTime || 0;

      if (currentMaxTime <= lastMessageTime && lastMessageTime > 0) {
        odb.close();
        return { importedCount: 0, skippedCount: 1, failedCount: 0 };
      }

      odb.close();

      // 全量解析（opencode parser 已做增量过滤）
      const messages = parseConversationFile(filePath, 'opencode');

      // 转换为数据库记录格式
      const records = messages.map((msg, idx) => ({
        id: createRecordId(sourceId, filePath, idx, msg),
        sourceId: sourceId,
        sessionId: null,
        role: msg.role,
        content: msg.content,
        toolCalls: msg.toolCalls || null,
        toolCallId: msg.toolCallId || null,
        metadata: msg.timestamp ? JSON.stringify({ timestamp: msg.timestamp }) : null,
        endedAt: msg.timestamp || null,
      }));

      // 批量插入
      const inserted = insertConversationsBatch(records);

      // 更新源状态
      updateConversationSourceStatus(sourceId, {
        lastSyncedAt: new Date().toISOString(),
        recordCount: countSourceRecords(sourceId),
        status: 'active',
      });

      // 保存增量元数据（opencode 用 lastMessageTime）
      saveIncrementalMeta(sourceId, 'opencode', 0, 0, currentMaxTime);

      return {
        importedCount: inserted,
        skippedCount: 0,
        failedCount: 0,
      };
    } catch {
      updateConversationSourceStatus(sourceId, {
        lastSyncedAt: new Date().toISOString(),
        recordCount: 0,
        status: 'error',
      });
      return { importedCount: 0, skippedCount: 0, failedCount: 1 };
    }
  }

  /**
   * 同步所有对话源。
   * 从数据库查询所有活跃的 conversation_sources，逐个同步。
   *
   * @returns {Promise<Array<{ sourceId: string, result: { importedCount: number, skippedCount: number, failedCount: number } }>>}
   */
  async function syncAll() {
    const sources = listConversationSources();
    const results = [];

    for (const source of sources) {
      if (source.status === 'error') continue; // 跳过已标记错误的源
      try {
        const result = await syncSource(source.id);
        results.push({ sourceId: source.id, result });
      } catch {
        results.push({
          sourceId: source.id,
          result: { importedCount: 0, skippedCount: 0, failedCount: 1 },
        });
      }
    }

    return results;
  }

  // ===================== 定时同步 =====================

  /**
   * 启动定时同步调度器。
   * @param {number} [intervalMs=3600000] - 同步间隔（毫秒），默认 1 小时
   */
  function startScheduler(intervalMs = 3600000) {
    if (schedulerTimer) return; // 已启动，不重复

    schedulerTimer = setInterval(() => {
      syncAll().catch(() => {
        // 定时同步失败静默处理
      });
    }, intervalMs);

    // 允许进程正常退出
    if (schedulerTimer.unref) {
      schedulerTimer.unref();
    }

    isRunning = true;
  }

  // ===================== 目录监听 =====================

  /**
   * 启动 fs.watch 监听所有对话源所在目录的变更。
   * 使用 500ms 防抖避免频繁触发。
   */
  function startWatcher() {
    if (watcher) return; // 已启动，不重复

    // 收集所有源路径的目录
    const sources = listConversationSources();
    const dirsToWatch = new Set();
    for (const source of sources) {
      try {
        const dir = dirname(source.path);
        dirsToWatch.add(dir);
      } catch {
        // 忽略无效路径
      }
    }

    // 为每个目录创建 watch（带防抖）
    let debounceTimer = null;
    const debouncedSync = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        syncAll().catch(() => {});
      }, 500);
    };

    for (const dir of dirsToWatch) {
      try {
        const fsWatch = watch(dir, { persistent: true }, (eventType, filename) => {
          // 只关注 JSONL 文件变更
          if (filename && filename.endsWith('.jsonl')) {
            debouncedSync();
          }
        });
        // 保存引用以便 stop 关闭
        if (!watcher) watcher = [];
        watcher.push(fsWatch);
      } catch {
        // 目录不存在或无权访问，跳过
      }
    }

    isRunning = true;
  }

  // ===================== 停止 =====================

  /**
   * 停止定时器和监听器。
   */
  function stop() {
    if (schedulerTimer) {
      clearInterval(schedulerTimer);
      schedulerTimer = null;
    }

    if (watcher) {
      for (const w of watcher) {
        try { w.close(); } catch { /* ignore */ }
      }
      watcher = null;
    }

    isRunning = false;
  }

  // 返回引擎实例
  return {
    syncAll,
    syncSource,
    startScheduler,
    startWatcher,
    stop,
    get isRunning() {
      return isRunning;
    },
  };
}
