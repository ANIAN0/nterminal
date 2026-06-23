import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closeDatabase,
  getDb,
  initializeDatabase,
  insertConversationSource,
  searchConversations,
} from '../../../server/database.mjs';

let tempDir;

afterEach(() => {
  closeDatabase();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function percentile95(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

describe('历史搜索基础', () => {
  it('100k 消息的三字符子串走 trigram，短查询安全回退 LIKE', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'nterminal-search-'));
    initializeDatabase(join(tempDir, 'nterminal.db'));
    const source = insertConversationSource({ path: 'fixture', agentType: 'codex' });
    const db = getDb();
    const insert = db.prepare(`
      INSERT INTO conversations
        (id, source_id, role, content, user_text, ended_at, message_index)
      VALUES (?, ?, 'user', ?, ?, ?, ?)
    `);
    db.transaction(() => {
      for (let index = 0; index < 100_000; index += 1) {
        const target = index % 997 === 0;
        const text = target ? `记录 ${index} 终端输入 latency-marker` : `记录 ${index} 普通内容`;
        insert.run(`message-${index}`, source.id, text, text, new Date(1_700_000_000_000 + index).toISOString(), index);
      }
      insert.run('literal-wildcards', source.id, '字面量 %_\' 安全', '字面量 %_\' 安全', '2026-01-01T00:00:00.000Z', 100_001);
    })();

    const chinese = searchConversations('终端输入', 'all', 20);
    const english = searchConversations('latency', 'all', 20);
    expect(chinese).toHaveLength(20);
    expect(english).toHaveLength(20);
    expect(chinese.every((item) => item.rank < 0)).toBe(true);
    expect(chinese.every((item) => item.conversation.content.includes('终端输入'))).toBe(true);

    expect(searchConversations('终端', 'all', 10)).toHaveLength(10);
    expect(searchConversations("%_'", 'all', 10).map((item) => item.conversation.id)).toEqual(['literal-wildcards']);

    // 先预热，再记录 20 次完整公共查询，门槛针对稳定查询而非首次建页成本。
    searchConversations('终端输入', 'all', 20);
    const samples = Array.from({ length: 20 }, () => {
      const startedAt = performance.now();
      searchConversations('终端输入', 'all', 20);
      return performance.now() - startedAt;
    });
    expect(percentile95(samples)).toBeLessThanOrEqual(250);

    const plan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT c.id FROM conversations_fts f
      JOIN conversations c ON c.rowid = f.rowid
      WHERE conversations_fts MATCH ?
    `).all('"终端输入"');
    expect(plan.some((row) => String(row.detail).includes('VIRTUAL TABLE INDEX'))).toBe(true);
  }, 30_000);
});
