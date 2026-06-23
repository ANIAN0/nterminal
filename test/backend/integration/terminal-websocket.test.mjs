import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPtyManager } from '../../../server/pty-manager.mjs';
import { decodeOutputFrame, encodeOutputFrame } from '../../../server/terminal-protocol.mjs';

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

  emitData(data) {
    for (const handler of this.dataHandlers) handler(data);
  }
}

function createHarness(ringLimitBytes = 16 * 1024 * 1024) {
  const tempDir = mkdtempSync(join(tmpdir(), 'nterminal-terminal-ws-'));
  const spawned = [];
  const manager = createPtyManager({
    ringLimitBytes,
    spawnPty: () => {
      const pty = new FakePty();
      spawned.push(pty);
      return pty;
    },
  });
  return { tempDir, manager, spawned };
}

describe('终端输出 offset 协议', () => {
  it('输出帧携带 uint64BE 起始 offset 并可还原 payload', () => {
    const frame = encodeOutputFrame(42n, Buffer.from('hello', 'utf8'));
    const decoded = decodeOutputFrame(frame);

    expect(decoded.type).toBe('output');
    expect(decoded.startOffset).toBe(42n);
    expect(decoded.payload.toString('utf8')).toBe('hello');
  });

  it('snapshot 与 live 输出按字节 offset 连续且无重漏', () => {
    const { tempDir, manager, spawned } = createHarness();
    try {
      const session = manager.createSession({ cwd: tempDir });
      spawned[0].emitData('abc');
      const snapshot = manager.getOutputSnapshot(session.id, 0n);
      expect(snapshot.ok).toBe(true);
      expect(snapshot.currentOffset).toBe(3n);
      expect(snapshot.frames.map((frame) => frame.startOffset)).toEqual([0n]);

      const events = [];
      manager.attachSession(session.id, (event) => {
        if (event.type === 'data') events.push(event);
      });
      spawned[0].emitData('de');

      expect(events).toEqual([expect.objectContaining({ startOffset: 3n, byteLength: 2 })]);
      const all = [...snapshot.frames, ...events].map((frame) => decodeOutputFrame(encodeOutputFrame(frame.startOffset, frame.payload ?? Buffer.from(frame.data, 'utf8'))));
      expect(all.map((frame) => frame.startOffset)).toEqual([0n, 3n]);
      expect(Buffer.concat(all.map((frame) => frame.payload)).toString('utf8')).toBe('abcde');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('lastOffset 早于 ring 起点时返回 OUTPUT_GAP 而不是静默继续', () => {
    const { tempDir, manager, spawned } = createHarness(4);
    try {
      const session = manager.createSession({ cwd: tempDir });
      spawned[0].emitData('abcdef');

      const snapshot = manager.getOutputSnapshot(session.id, 0n);

      expect(snapshot.ok).toBe(false);
      expect(snapshot.error.code).toBe('OUTPUT_GAP');
      expect(snapshot.oldestOffset).toBe(2n);
      expect(snapshot.currentOffset).toBe(6n);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
