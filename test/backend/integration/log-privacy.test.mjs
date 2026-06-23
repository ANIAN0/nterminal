import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../../server/logger.mjs';

let tempDir;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe('鏃ュ織闅愮', () => {
  it('鏃ュ織淇濈暀 contextId/code/sourceId锛屼絾涓嶅啓鍏ュ懡浠ゃ€佽姹傛鏂囨垨瀵硅瘽姝ｆ枃', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'nterminal-log-'));
    const logger = createLogger({ logDir: tempDir, fileName: 'diagnostics.log', consoleEnabled: false });

    logger.write('user_message', {
      contextId: 'ctx-privacy',
      sourceId: 'source-1',
      code: 'SOURCE_SCHEMA',
      command: 'SECRET_CANARY_COMMAND',
      body: 'SECRET_CANARY_BODY',
      text: 'SECRET_CANARY_TEXT',
      message: 'SECRET_CANARY_MESSAGE',
      url: 'http://localhost/SECRET_CANARY_URL',
      cwd: 'C:/SECRET_CANARY_CWD',
      dbPath: 'C:/SECRET_CANARY_DB',
    });

    const content = readFileSync(join(tempDir, 'diagnostics.log'), 'utf8');
    expect(content).toContain('ctx-privacy');
    expect(content).toContain('SOURCE_SCHEMA');
    expect(content).toContain('source-1');
    expect(content).not.toContain('SECRET_CANARY_COMMAND');
    expect(content).not.toContain('SECRET_CANARY_BODY');
    expect(content).not.toContain('SECRET_CANARY_TEXT');
    expect(content).not.toContain('SECRET_CANARY_MESSAGE');
    expect(content).not.toContain('SECRET_CANARY_URL');
    expect(content).not.toContain('SECRET_CANARY_CWD');
    expect(content).not.toContain('SECRET_CANARY_DB');
  });
});

