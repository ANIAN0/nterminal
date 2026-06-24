/**
 * 验证同步引擎在主线程 db 锁竞争下不会产生 unhandledRejection。
 *
 * 关键路径：
 *   performSync(try) → runJsonlWorker 抛错 → catch → updateSourceError
 *   updateSourceError 在 db 仍被 worker 大事务持有时也可能抛 SQLITE_BUSY。
 *   修复前：二次 SQLITE_BUSY 直接冒泡为 unhandledRejection（dev server stderr 刷屏）。
 *   修复后：catch 内部嵌套 try/catch 兜住二次失败，syncSource 仍能返回结构化 error 结果。
 */

import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 测试用 mock：每个构造的 worker 实例都会注册到 mockWorkerRegistry，测试主体可直接 emit 事件。
const mockWorkerRegistry = [];
class MockWorkerClass extends EventEmitter {
  constructor() {
    super();
    mockWorkerRegistry.push(this);
  }
  // 真实 worker 通过 postMessage 与主线程通信；mock 不需要真实发送。
  postMessage() {}
}

// 把 node:worker_threads 整个替换为我们的 mock，使 runJsonlWorker 拿到的 Worker 是 MockWorkerClass。
// vi.mock 工厂只能引用以 `mock` 前缀的变量，mockWorkerRegistry / MockWorkerClass 都满足。
vi.mock('node:worker_threads', () => ({
  Worker: MockWorkerClass,
}));

const { closeDatabase, getDb, initializeDatabase, insertConversationSource } = await import('../../../server/database.mjs');
const { createImportEngine } = await import('../../../server/conversation-import.mjs');

let tempDir;
afterEach(() => {
  closeDatabase();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
  mockWorkerRegistry.length = 0;
  vi.restoreAllMocks();
});

describe('SQLITE_BUSY 二次失败的兜底', () => {
  it('updateSourceError 自身抛 SQLITE_BUSY 时, syncSource 仍返回结构化 error, 不 reject', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'nterminal-busy-guard-'));
    const sourceDir = join(tempDir, 'src');
    mkdirSync(sourceDir, { recursive: true });
    // 放一个会被 detectFormat 拒识的文件，触发 worker 端正常路径
    writeFileSync(join(sourceDir, 'a.jsonl'), '{"x":1}\n');
    initializeDatabase(join(tempDir, 'nterminal.db'));
    const source = insertConversationSource({ path: sourceDir, agentType: 'pi' });

    const db = getDb();
    // 拦截 updateSourceError 内部的 UPDATE：让它抛 SQLITE_BUSY，复现"主线程在 worker 大事务期间争用锁"场景。
    const realPrepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      if (sql.includes('last_error_code')) {
        // 复刻 better-sqlite3 抛 SQLITE_BUSY 时的形状：name + code + message。
        const err = new Error('database is locked');
        err.code = 'SQLITE_BUSY';
        throw err;
      }
      return realPrepare(sql);
    };

    const engine = createImportEngine({ db });
    const promise = engine.syncSource(source.id);
    // 让当前已经构造好的 worker 立即 emit error，触发 performSync 的 catch 块。
    // runJsonlWorker 内部 worker.once('error', reject) 会把异常抛给 performSync。
    const worker = mockWorkerRegistry[mockWorkerRegistry.length - 1];
    worker.emit('error', new Error('模拟 worker 失败'));

    // 关键断言：在 catch 块的 updateSourceError 自身抛 SQLITE_BUSY 的情况下，
    // 二次失败被嵌套 try/catch 兜住，syncSource 解析为 error 状态而非 reject。
    // 如果嵌套 try/catch 缺失，promise 会 reject，expect.toEqual 不会执行，
    // 测试会因 unhandledRejection 而失败。
    const result = await promise;
    expect(result).toMatchObject({
      sourceId: source.id,
      state: 'error',
      error: { retryable: true },
    });
    engine.stop();
  });
});
