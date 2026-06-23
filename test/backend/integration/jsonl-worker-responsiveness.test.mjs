import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDatabase, getDb, initializeDatabase, insertConversationSource } from '../../../server/database.mjs';
import { createImportEngine } from '../../../server/conversation-import.mjs';

let tempDir;

afterEach(() => {
  closeDatabase();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe('JSONL worker 响应性', () => {
  it('10k 消息解析和原子 FTS 写入期间主线程心跳小于 100ms', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'nterminal-jsonl-worker-'));
    const sourcePath = join(tempDir, 'session.jsonl');
    const lines = [JSON.stringify({ type: 'session', version: 3, id: 'large-pi', cwd: 'H:/fixture', timestamp: '2026-01-01T00:00:00.000Z' })];
    for (let index = 0; index < 10_000; index += 1) {
      lines.push(JSON.stringify({ type: 'message', timestamp: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`, message: { role: index % 2 ? 'assistant' : 'user', content: `消息 ${index}` } }));
    }
    writeFileSync(sourcePath, lines.join('\n'));
    initializeDatabase(join(tempDir, 'nterminal.db'));
    const source = insertConversationSource({ path: sourcePath, agentType: 'pi' });
    const engine = createImportEngine({ db: getDb() });
    let last = performance.now();
    let maxDelay = 0;
    const heartbeat = setInterval(() => {
      const now = performance.now();
      maxDelay = Math.max(maxDelay, now - last);
      last = now;
    }, 10);
    const result = await engine.syncSource(source.id);
    clearInterval(heartbeat);
    expect(result).toMatchObject({ state: 'active', inserted: 10_000 });
    expect(maxDelay).toBeLessThan(100);
    engine.stop();
  }, 60_000);
});
