import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDatabase, getDb, initializeDatabase, getSchemaVersion, insertConversationSource } from '../../../server/database.mjs';
import { getHealthStatus } from '../../../server/health-service.mjs';

let tempDir;

afterEach(() => {
  closeDatabase();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe('健康检查', () => {
  it('核心数据库和 PTY manager 就绪时返回 ready，且来源错误不降级核心 health', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'nterminal-health-'));
    initializeDatabase(join(tempDir, 'nterminal.db'));
    const source = insertConversationSource({ path: join(tempDir, 'missing'), agentType: 'opencode' });
    getDb().prepare(`
      UPDATE conversation_sources
      SET status = 'error', sync_state = 'error', last_error_code = 'SOURCE_MISSING'
      WHERE id = ?
    `).run(source.id);

    const health = getHealthStatus({
      getSchemaVersion,
      getActiveSessions: () => [{ id: 'tab-1' }],
    });

    expect(health.statusCode).toBe(200);
    expect(health.body).toMatchObject({
      status: 'ready',
      version: '1.3',
      schemaVersion: expect.any(Number),
      activeSessions: 1,
      sourceSummary: { total: 1, error: 1 },
    });
  });

  it('核心检查失败时返回 503 not_ready 和 failedChecks', () => {
    const health = getHealthStatus({
      getSchemaVersion: () => { throw new Error('schema unavailable'); },
      getActiveSessions: () => [],
    });

    expect(health.statusCode).toBe(503);
    expect(health.body.status).toBe('not_ready');
    expect(health.body.failedChecks).toEqual([expect.objectContaining({ code: 'SCHEMA_UNAVAILABLE' })]);
  });
});
