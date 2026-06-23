import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  closeDatabase,
  deleteConversationSource,
  getDb,
  initializeDatabase,
  insertConversation,
  insertConversationSource,
  queryCompletion,
  searchConversations,
} from '../server/database.mjs';
import { detectFormat, parseConversationFile } from '../server/conversation-parser.mjs';

let tempDir;

afterEach(() => {
  closeDatabase();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe('数据库', () => {
  it('初始化后可写入、搜索并在删除来源时保留纯文本对话', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'nterminal-db-'));
    initializeDatabase(join(tempDir, 'test.db'));
    const source = insertConversationSource({ path: 'fixture', agentType: 'codex' });

    expect(insertConversation({
      id: 'message-1',
      sourceId: source.id,
      role: 'user',
      content: '你好，SQLite',
    })).toBe(true);
    expect(queryCompletion('你好')).toHaveLength(1);
    expect(searchConversations('SQLite')[0].conversation.id).toBe('message-1');
    expect(getDb().prepare('SELECT content FROM conversations WHERE id = ?').get('message-1')?.content).toBe('你好，SQLite');
    expect(deleteConversationSource(source.id)).toBe(true);
    // 删除来源时依靠 ON DELETE SET NULL 保留已导入记录。
    expect(getDb().prepare('SELECT source_id FROM conversations WHERE id = ?').get('message-1')?.source_id).toBeNull();
  });
});

describe('Claude 历史解析', () => {
  it('识别并解析 history.jsonl 的 display 记录', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'nterminal-parser-'));
    const file = join(tempDir, 'history.jsonl');
    writeFileSync(file, `${JSON.stringify({
      display: '检查构建失败',
      timestamp: 1_700_000_000_000,
      project: { path: 'D:/workspace' },
    })}\n`, 'utf8');

    expect(detectFormat(file)).toBe('claude');
    expect(parseConversationFile(file, 'claude')).toMatchObject([
      { role: 'user', content: '检查构建失败' },
    ]);
  });
});
