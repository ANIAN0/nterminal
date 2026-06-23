import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
let child;
let tempDir;

function getFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitForHealth(url, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      const body = await res.json();
      return { status: res.status, body };
    } catch (err) {
      lastError = err;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
  }
  throw lastError || new Error('health timeout');
}

async function stopChild() {
  if (!child || child.killed) return;
  const current = child;
  await new Promise((resolveStop) => {
    current.once('exit', resolveStop);
    current.kill();
    setTimeout(resolveStop, 5000);
  });
}

afterEach(async () => {
  await stopChild();
  child = undefined;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  tempDir = undefined;
});

describe('HTTP 健康检查 smoke', () => {
  it('真实服务进程通过 GET /api/health 返回 ready payload', async () => {
    const tmpRoot = join(root, 'test-results', 'tmp');
    mkdirSync(tmpRoot, { recursive: true });
    tempDir = mkdtempSync(join(tmpRoot, 'nterminal-health-http-'));
    mkdirSync(join(tempDir, 'data'), { recursive: true });
    const port = await getFreePort();
    child = spawn(process.execPath, ['server.mjs'], {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        HOST: '127.0.0.1',
        PORT: String(port),
        DATA_DIR: join(tempDir, 'data'),
        POC_VERBOSE_LOG: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const health = await waitForHealth(`http://127.0.0.1:${port}/api/health`);

    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({
      ok: true,
      data: {
        status: 'ready',
        version: '1.3',
        schemaVersion: expect.any(Number),
        activeSessions: expect.any(Number),
      },
    });
  }, 120000);
});
