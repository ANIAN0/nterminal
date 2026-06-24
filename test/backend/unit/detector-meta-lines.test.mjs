/**
 * detectFormat 在 Claude Code 真实会话文件上的识别覆盖。
 *
 * 背景：Claude Code 在每个 session jsonl 头部写入若干元数据行
 * （last-prompt/queue-operation/mode/permission-mode/ai-title 等），
 * 这些行不含消息正文但应当把文件归类为 Claude，
 * 由 parseSessionFile 进一步过滤 message 条目。
 * 类似的，Codex 的 session_index.jsonl 没有 session_meta 头但有 id+thread_name+updated_at，
 * 也应被识别为 Codex（索引文件，由后续按 cwd 解析跳过）。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectFormat } from '../../../server/conversation-parser.mjs';

let tempDir;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe('detectFormat 元数据行识别', () => {
  it.each([
    ['last-prompt', '{"type":"last-prompt","leafUuid":"x","sessionId":"s1"}'],
    ['queue-operation', '{"type":"queue-operation","operation":"enqueue","sessionId":"s1"}'],
    ['mode', '{"type":"mode","mode":"normal","sessionId":"s1"}'],
    ['permission-mode', '{"type":"permission-mode","permissionMode":"bypassPermissions","sessionId":"s1"}'],
    ['ai-title', '{"type":"ai-title","aiTitle":"拆分代码节点","sessionId":"s1"}'],
    ['file-history-snapshot', '{"type":"file-history-snapshot","messageId":"m","sessionId":"s1"}'],
  ])('Claude Code 首行 type=%s 仍识别为 claude', (_label, firstLine) => {
    tempDir = mkdtempSync(join(tmpdir(), 'nterminal-detect-claude-'));
    const fp = join(tempDir, 'session.jsonl');
    writeFileSync(fp, `${firstLine}\n`);
    expect(detectFormat(fp)).toBe('claude');
  });

  it('Claude Code 首行只有 sessionId 兜底识别为 claude', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'nterminal-detect-claude-'));
    const fp = join(tempDir, 'session.jsonl');
    writeFileSync(fp, '{"sessionId":"abc-123","unknown":"shape"}\n');
    expect(detectFormat(fp)).toBe('claude');
  });

  it('Codex session_index.jsonl 被识别为 codex', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'nterminal-detect-codex-'));
    const fp = join(tempDir, 'session_index.jsonl');
    writeFileSync(fp, '{"id":"019daedf-a003","thread_name":"检查代码","updated_at":"2026-04-21T07:10:02.2988125Z"}\n');
    expect(detectFormat(fp)).toBe('codex');
  });

  it('完全无关的 fixture 文件保持 null', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'nterminal-detect-null-'));
    const fp = join(tempDir, 'fixture.jsonl');
    // 仅嵌套 type，不是顶层 type，且无 sessionId → 仍应返回 null
    writeFileSync(fp, '{"timestamp":"2024-01-01T00:00:00.000Z","message":{"content":[{"type":"tool_use"}]}}\n');
    expect(detectFormat(fp)).toBeNull();
  });
});
