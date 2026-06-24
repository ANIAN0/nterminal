/**
 * 目录中混入无法识别的 JSONL 时，sync 仍应让合法 Agent 文件入库。
 *
 * 真实用户机器上 claude/codex 根目录常混有 fixtures / 全局索引 / 元数据行，
 * 它们的 detectFormat 会返回 null。不能让单文件"无法识别"阻断整个 source。
 */

import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDatabase, getDb, initializeDatabase, insertConversationSource } from '../../../server/database.mjs';
import { createImportEngine } from '../../../server/conversation-import.mjs';

const piFixture = resolve(import.meta.dirname, '../../fixtures/pi/session.jsonl');
let tempDir;

afterEach(() => {
  closeDatabase();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe('来源目录混有不可识别文件时的同步行为', () => {
  it('合法 pi 会话 + 无法识别文件混存时, 合法文件正常入库且 source 仍 active', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'nterminal-mixed-pi-'));
    const sourceDir = join(tempDir, 'source');
    mkdirSync(sourceDir);
    // 合法 pi session
    cpSync(piFixture, join(sourceDir, 'session.jsonl'));
    // 完全无关的 fixture（detectFormat 返回 null）
    writeFileSync(join(sourceDir, 'transcript.jsonl'),
      '{"timestamp":"2024-01-01T00:00:00.000Z","message":{"content":[{"type":"tool_use"}]}}\n');

    initializeDatabase(join(tempDir, 'nterminal.db'));
    const source = insertConversationSource({ path: sourceDir, agentType: 'pi' });
    const engine = createImportEngine({ db: getDb() });
    const result = await engine.syncSource(source.id);

    expect(result.state).toBe('active');
    expect(result.failedFiles.length).toBeGreaterThanOrEqual(1);
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM conversations WHERE source_id = ?').get(source.id).count).toBeGreaterThan(0);
    engine.stop();
  });

  it('目录全是非 Agent 文件时整体仍标记 error, 但失败信息保持可读', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'nterminal-mixed-empty-'));
    const sourceDir = join(tempDir, 'source');
    mkdirSync(sourceDir);
    writeFileSync(join(sourceDir, 'fixture.jsonl'), '{"timestamp":"x","message":{"content":[{"type":"tool_use"}]}}\n');

    initializeDatabase(join(tempDir, 'nterminal.db'));
    const source = insertConversationSource({ path: sourceDir, agentType: 'claude' });
    const engine = createImportEngine({ db: getDb() });
    const result = await engine.syncSource(source.id);

    expect(result.state).toBe('error');
    expect(result.error).toMatchObject({ code: 'PARSE_ERROR', retryable: true });
    engine.stop();
  });
});
