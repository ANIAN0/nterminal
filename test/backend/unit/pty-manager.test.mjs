import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPtyManager } from '../../../server/pty-manager.mjs';

class FakePty {
  constructor() {
    this.dataHandlers = [];
    this.exitHandlers = [];
    this.kill = vi.fn();
    this.write = vi.fn();
    this.resize = vi.fn();
  }

  onData(handler) {
    this.dataHandlers.push(handler);
  }

  onExit(handler) {
    this.exitHandlers.push(handler);
  }

  emitExit(exitCode = 0, signal = 0) {
    for (const handler of this.exitHandlers) handler({ exitCode, signal });
  }
}

function createHarness() {
  const tempDir = mkdtempSync(join(tmpdir(), 'nterminal-pty-manager-'));
  const spawned = [];
  const manager = createPtyManager({
    spawnPty: () => {
      const pty = new FakePty();
      spawned.push(pty);
      return pty;
    },
    graceMs: 300_000,
  });
  return { tempDir, manager, spawned };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('PTY 生命周期状态机', () => {
  it('已连接但空闲超过十分钟也不会被误杀', () => {
    vi.useFakeTimers();
    const { tempDir, manager, spawned } = createHarness();
    try {
      const session = manager.createSession({ cwd: tempDir });
      const listener = vi.fn();
      expect(manager.attachSession(session.id, listener)).toBe(true);

      vi.advanceTimersByTime(600_000);

      expect(spawned[0].kill).not.toHaveBeenCalled();
      expect(manager.getSession(session.id)?.status).toBe('running');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('最后一个连接断开后进入五分钟宽限，宽限内重连会取消回收', () => {
    vi.useFakeTimers();
    const { tempDir, manager, spawned } = createHarness();
    try {
      const session = manager.createSession({ cwd: tempDir });
      const listener = vi.fn();
      expect(manager.attachSession(session.id, listener)).toBe(true);
      expect(manager.detachSession(session.id, listener)).toBe(true);

      vi.advanceTimersByTime(299_999);
      expect(spawned[0].kill).not.toHaveBeenCalled();
      expect(manager.getSession(session.id)?.status).toBe('running');

      expect(manager.attachSession(session.id, vi.fn())).toBe(true);
      vi.advanceTimersByTime(1);
      expect(spawned[0].kill).not.toHaveBeenCalled();
      expect(manager.getSession(session.id)?.status).toBe('running');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('断线宽限到期才终止 PTY 并移除运行态', () => {
    vi.useFakeTimers();
    const { tempDir, manager, spawned } = createHarness();
    try {
      const session = manager.createSession({ cwd: tempDir });
      const listener = vi.fn();
      manager.attachSession(session.id, listener);
      manager.detachSession(session.id, listener);

      vi.advanceTimersByTime(300_000);

      expect(spawned[0].kill).toHaveBeenCalledTimes(1);
      expect(manager.getSession(session.id)).toBeNull();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('主动关闭立即终止并区别于自然退出', () => {
    vi.useFakeTimers();
    const { tempDir, manager, spawned } = createHarness();
    try {
      const session = manager.createSession({ cwd: tempDir });
      const listener = vi.fn();
      manager.attachSession(session.id, listener);

      expect(manager.closeSession(session.id, 'active_close')).toBe(true);

      expect(spawned[0].kill).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: 'closed', reason: 'active_close' }));
      expect(manager.getSession(session.id)).toBeNull();

      const natural = manager.createSession({ cwd: tempDir });
      const naturalListener = vi.fn();
      manager.attachSession(natural.id, naturalListener);
      spawned[1].emitExit(7, 0);

      expect(naturalListener).toHaveBeenCalledWith(expect.objectContaining({ type: 'exit', exitCode: 7 }));
      expect(manager.getSession(natural.id)?.status).toBe('ended');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
