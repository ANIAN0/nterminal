import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseSourceFile } from '../../../server/conversation-parser.mjs';
import { createOpenCodeFixture } from '../../fixtures/opencode/create-database.mjs';

const fixtures = resolve(import.meta.dirname, '../../fixtures');
let tempDir;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe('统一 parser 会话契约', () => {
  it.each([
    ['claude', resolve(fixtures, 'claude/session.jsonl')],
    ['codex', resolve(fixtures, 'codex/session.jsonl')],
    ['pi', resolve(fixtures, 'pi/session.jsonl')],
  ])('%s 返回完整会话和有序消息', (agentType, filePath) => {
    const sessions = parseSourceFile(filePath, agentType);
    expect(sessions).toHaveLength(1);
    assertSession(sessions[0], agentType);
  });

  it('opencode 按原生 session 分组并保留目录', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'nterminal-opencode-contract-'));
    const dbPath = join(tempDir, 'opencode.db');
    createOpenCodeFixture(dbPath);
    const sessions = parseSourceFile(dbPath, 'opencode');
    expect(sessions).toHaveLength(1);
    assertSession(sessions[0], 'opencode');
  });

  it('未知 role 返回结构化错误', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'nterminal-parser-role-'));
    const filePath = join(tempDir, 'unknown.jsonl');
    writeFileSync(filePath, [
      JSON.stringify({ type: 'session', version: 3, id: 'unknown-role', cwd: 'H:/fixture', timestamp: '2026-01-01T00:00:00.000Z' }),
      JSON.stringify({ type: 'message', message: { role: 'alien', content: 'invalid' } }),
    ].join('\n'));
    expect(() => parseSourceFile(filePath, 'pi')).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_ROLE' }));
  });
});

function assertSession(session, agentType) {
  expect(session.sessionKey).toMatch(new RegExp(`^${agentType}:`));
  expect(session.nativeSessionId).toBeTruthy();
  expect(session.cwd).toBeTruthy();
  expect(session.sourceFile).toBeTruthy();
  expect(session.messages.length).toBeGreaterThan(0);
  expect(session.messages.map((message) => message.messageIndex)).toEqual(
    session.messages.map((_, index) => index),
  );
  for (const message of session.messages) {
    expect(message.nativeMessageId).toBeTruthy();
    expect(['user', 'assistant', 'system', 'tool']).toContain(message.role);
  }
}
