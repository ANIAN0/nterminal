/**
 * PTY manager.
 * 运行时唯一持有 PTY 进程、连接集合、断线宽限计时和自然退出状态。
 */

import pty from 'node-pty';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { validateCwd, checkDirectoryExists } from './validation.mjs';

function cleanEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env.TERM = env.TERM || 'xterm-256color';
  return env;
}

/**
 * 探测一个可执行文件是否在 PATH 中可解析（跨平台 where/which）。
 * 失败返回 null，绝不抛错。
 */
function whichOnPath(cmd) {
  try {
    const locator = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(locator, [cmd], { stdio: ['ignore', 'pipe', 'ignore'] });
    const s = out.toString().trim().split(/\r?\n/)[0];
    return s || null;
  } catch {
    return null;
  }
}

// 缓存 Windows shell 解析结果（进程内）。
let resolvedWindowsShell = null;

/**
 * 解析 Windows 默认 shell：优先 PowerShell 7(pwsh) → Windows PowerShell(powershell)
 * → cmd.exe 兜底。允许 NTERM_SHELL 环境变量覆盖（值为文件名或绝对路径）。
 */
function resolveWindowsShell() {
  if (process.env.NTERM_SHELL) {
    return process.env.NTERM_SHELL;
  }
  if (resolvedWindowsShell) return resolvedWindowsShell;
  const candidates = ['pwsh.exe', 'powershell.exe', 'cmd.exe'];
  for (const candidate of candidates) {
    const resolved = whichOnPath(candidate);
    if (resolved) {
      resolvedWindowsShell = resolved;
      return resolved;
    }
  }
  resolvedWindowsShell = process.env.COMSPEC || 'cmd.exe';
  return resolvedWindowsShell;
}

// shellConfig：按平台返回 spawn 的 file/args；Windows 区分 PowerShell 与 cmd 走不同参数。
function shellConfig() {
  if (process.platform === 'win32') {
    const file = resolveWindowsShell();
    const base = (file.split(/[\\/]/).pop() || '').toLowerCase();
    if (base.startsWith('powershell') || base.startsWith('pwsh')) {
      return { file, args: ['-NoLogo'] };
    }
    return { file, args: ['/d'] };
  }
  return {
    file: process.env.SHELL || '/bin/bash',
    args: [],
  };
}

// defaultShellCommand：仅返回对外显示用的 shell 名；不参与实际 spawn，spawn 由 shellConfig 决定。
function defaultShellCommand() {
  if (process.platform === 'win32') {
    const file = resolveWindowsShell();
    const base = (file.split(/[\\/]/).pop() || '').toLowerCase();
    return base.startsWith('powershell') || base.startsWith('pwsh') ? base : 'cmd.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

function spawnInteractiveShell({ cwd, cols = 80, rows = 24 }) {
  const config = shellConfig();
  return pty.spawn(config.file, config.args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: cleanEnv(),
  });
}

/**
 * 命令式 spawn：执行单条命令（保留供后续 TUI 入口；本期不挂 HTTP）。
 */
export function spawnCommand({ cwd, command, cols = 80, rows = 24 }) {
  const config = resolveSpawnConfig(command, process.platform);
  return pty.spawn(config.file, config.args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: cleanEnv(),
  });
}

// firstCommandToken：取出命令的第一个 token，给 Windows 内建命令与可执行路径判断复用。
function firstCommandToken(command) {
  if (typeof command !== 'string') return '';
  const trimmed = command.trim();
  if (!trimmed) return '';
  return trimmed.split(/\s+/)[0] || '';
}

// isWindowsBuiltin：判断 token 是否属于 cmd.exe 内建命令，避免误把内建名当可执行路径。
function isWindowsBuiltin(token) {
  if (!token) return false;
  const normalized = token.toLowerCase();
  const builtins = new Set([
    'dir', 'cd', 'copy', 'move', 'del', 'rd', 'rmdir', 'md', 'mkdir', 'ren', 'rename',
    'type', 'echo', 'set', 'setlocal', 'endlocal', 'if', 'for', 'goto', 'call',
    'cls', 'exit', 'pushd', 'popd', 'start', 'tasklist', 'taskkill', 'where', 'help',
  ]);
  return builtins.has(normalized);
}

/**
 * 是否能直接 resolve 出一个可执行路径（即不需要 shell 求值）。
 * 本期不挂 HTTP，仅作为未来 TUI 入口的预判逻辑保留。
 */
export function canResolveCommand(command) {
  const token = firstCommandToken(command);
  if (!token) return false;
  if (token.includes('/') || token.includes('\\')) return true;
  if (process.platform === 'win32' && /^[A-Za-z]:[\\/]/.test(token)) return true;
  if (isWindowsBuiltin(token)) return true;
  return true;
}

/**
 * 根据平台把字符串 command 解析成 spawn 的 file/args。
 */
export function resolveSpawnConfig(command, platform = process.platform) {
  if (platform === 'win32') {
    return {
      file: process.env.COMSPEC || 'cmd.exe',
      args: ['/d', '/s', '/c', command],
    };
  }
  return {
    file: process.env.SHELL || '/bin/bash',
    args: ['-lc', command],
  };
}

// serializeSession：把内部 session 字段转 API 形态，剔除 ptyProcess 等运行态对象。
function serializeSession(session) {
  return {
    id: session.id,
    cwd: session.cwd,
    command: session.command,
    tagLabel: session.tagLabel || null,
    status: session.status,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    exitCode: session.exitCode,
    signal: session.signal,
    error: session.error || null,
  };
}

// appendPreview：维护最近 100 行的 ring buffer，给 /api/tabs/:id/preview 提供快照。
function appendPreview(session, data) {
  session.outputBuffer += data;
  const lines = data.split('\n');
  for (const line of lines) {
    if (!line) continue;
    session.ringBuffer.push(line);
    if (session.ringBuffer.length > 100) session.ringBuffer.shift();
  }
}

/**
 * 把一段 PTY 输出追加到按 offset 排布的环形缓冲；超过 ringLimitBytes 时丢弃最早字节。
 * @param {object} session
 * @param {string} data
 * @returns {{startOffset: bigint, payload: Buffer}}
 */
function appendOutputFrame(session, data) {
  const payload = Buffer.from(data, 'utf8');
  const startOffset = session.outputOffset;
  session.outputOffset += BigInt(payload.length);
  session.outputChunks.push({ startOffset, payload });
  session.outputRingBytes += payload.length;
  while (session.outputRingBytes > session.ringLimitBytes && session.outputChunks.length > 0) {
    const overflow = session.outputRingBytes - session.ringLimitBytes;
    const first = session.outputChunks[0];
    if (first.payload.length <= overflow) {
      const removed = session.outputChunks.shift();
      session.outputRingBytes -= removed.payload.length;
      continue;
    }
    first.payload = first.payload.subarray(overflow);
    first.startOffset += BigInt(overflow);
    session.outputRingBytes -= overflow;
  }
  return { startOffset, payload };
}

/**
 * 构造一个 PTY 管理器实例；可通过 spawnPty/idFactory/graceMs 注入测试替身。
 * @param {{spawnPty?: Function, idFactory?: () => string, graceMs?: number,
 *         ringLimitBytes?: number, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout}} [options]
 */
export function createPtyManager({
  spawnPty = spawnInteractiveShell,
  idFactory = randomUUID,
  graceMs = 300_000,
  ringLimitBytes = 16 * 1024 * 1024,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const sessions = new Map();

  // notify：把事件 fan-out 给 session 上所有监听者，单个监听者抛错不会影响其他订阅。
  function notify(session, event) {
    for (const listener of session.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('Session listener error:', err instanceof Error ? err.message : err);
      }
    }
  }

  // clearGraceTimer：取消会话上的宽限 kill 计时器，常用于 attach 成功或显式关闭。
  function clearGraceTimer(session) {
    if (!session.graceTimer) return;
    clearTimer(session.graceTimer);
    session.graceTimer = null;
    session.detachedAt = null;
  }

  // finishRunningSession：把 running → ended；可选择是否 kill PTY 与是否从 sessions Map 删除。
  function finishRunningSession(session, reason, { remove = false, kill = false } = {}) {
    if (session.status !== 'running') return false;
    clearGraceTimer(session);
    session.status = 'ended';
    session.endedAt = new Date().toISOString();
    session.closeReason = reason;
    if (kill && session.ptyProcess) {
      // 主动关闭和宽限回收必须由 manager 触发 kill，避免 WS close 直接杀进程。
      session.ptyProcess.kill();
    }
    notify(session, { type: 'closed', reason });
    if (remove) sessions.delete(session.id);
    return true;
  }

  // scheduleGraceTimer：会话没有监听者时启动宽限计时，超时后会回收 PTY 防止常驻僵尸进程。
  function scheduleGraceTimer(session) {
    if (session.status !== 'running' || session.listeners.size > 0 || session.graceTimer) return;
    session.detachedAt = new Date().toISOString();
    session.graceTimer = setTimer(() => {
      finishRunningSession(session, 'grace_timeout', { remove: true, kill: true });
    }, graceMs);
    session.graceTimer.unref?.();
  }

  // createFailedSession：spawn 失败时仍写入 sessions Map，返回结构化失败对象给调用方。
  function createFailedSession(sessionId, cwd, command, error) {
    const now = new Date().toISOString();
    const session = {
      id: sessionId,
      cwd,
      command,
      tagLabel: null,
      status: 'error',
      startedAt: now,
      endedAt: now,
      exitCode: null,
      signal: null,
      error,
      ptyProcess: null,
      outputBuffer: '',
      ringBuffer: [],
      outputChunks: [],
      outputOffset: 0n,
      outputRingBytes: 0,
      ringLimitBytes,
      listeners: new Set(),
      detachedAt: null,
      graceTimer: null,
    };
    sessions.set(sessionId, session);
    return serializeSession(session);
  }

  // createSession：校验 cwd 后 spawn PTY，绑定 onExit/onData 并把会话登记到 sessions Map。
  function createSession({ cwd, cols = 80, rows = 24, tagLabel = null } = {}) {
    const sessionId = idFactory();
    const command = defaultShellCommand();
    let resolvedCwd;
    if (cwd !== undefined && cwd !== null) {
      const valid = validateCwd(cwd);
      if (!valid.ok) return createFailedSession(sessionId, cwd, command, valid.message);
      const exists = checkDirectoryExists(cwd);
      if (!exists.ok) return createFailedSession(sessionId, cwd, command, exists.message);
      resolvedCwd = exists.resolved;
    } else {
      resolvedCwd = process.cwd();
    }

    try {
      const ptyProcess = spawnPty({ cwd: resolvedCwd, cols, rows });
      const session = {
        id: sessionId,
        cwd: resolvedCwd,
        command,
        tagLabel: tagLabel || null,
        status: 'running',
        startedAt: new Date().toISOString(),
        endedAt: null,
        exitCode: null,
        signal: null,
        error: null,
        ptyProcess,
        outputBuffer: '',
        ringBuffer: [],
        outputChunks: [],
        outputOffset: 0n,
        outputRingBytes: 0,
        ringLimitBytes,
        listeners: new Set(),
        detachedAt: null,
        graceTimer: null,
        closeReason: null,
      };

      ptyProcess.onExit(({ exitCode, signal }) => {
        if (session.status !== 'running') return;
        clearGraceTimer(session);
        session.status = 'ended';
        session.endedAt = new Date().toISOString();
        session.exitCode = exitCode;
        session.signal = signal;
        notify(session, { type: 'exit', exitCode, signal });
      });

      ptyProcess.onData((data) => {
        appendPreview(session, data);
        const frame = appendOutputFrame(session, data);
        notify(session, {
          type: 'data',
          data,
          startOffset: frame.startOffset,
          byteLength: frame.payload.length,
          payload: frame.payload,
        });
      });

      sessions.set(sessionId, session);
      return serializeSession(session);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return createFailedSession(sessionId, resolvedCwd, command, message);
    }
  }

  // getSession：按 id 取出会话的可序列化形态；不存在返回 null。
  function getSession(sessionId) {
    const session = sessions.get(sessionId);
    return session ? serializeSession(session) : null;
  }

  // getPtyProcess：按 id 取出原始 node-pty 进程对象，供需要直接操作 PTY 的少数调用方使用。
  function getPtyProcess(sessionId) {
    return sessions.get(sessionId)?.ptyProcess || null;
  }

  // attachSession：注册监听者并清掉宽限计时；仅 running 状态可成功。
  function attachSession(sessionId, listener) {
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'running') return false;
    clearGraceTimer(session);
    session.listeners.add(listener);
    return true;
  }

  // detachSession：移除监听者，并在无监听者时启动宽限计时。
  function detachSession(sessionId, listener) {
    const session = sessions.get(sessionId);
    if (!session) return false;
    const deleted = session.listeners.delete(listener);
    scheduleGraceTimer(session);
    return deleted;
  }

  // writeToSession：把数据写入 PTY；session 不存在或已结束返回 false。
  function writeToSession(sessionId, data) {
    const session = sessions.get(sessionId);
    if (!session || !session.ptyProcess || session.status !== 'running') return false;
    try {
      session.ptyProcess.write(data);
      return true;
    } catch (err) {
      console.error('PTY write failed:', err instanceof Error ? err.message : err);
      return false;
    }
  }

  // resize：调整 PTY 终端尺寸，仅在 running 状态下生效。
  function resize(sessionId, cols, rows) {
    const session = sessions.get(sessionId);
    if (!session || !session.ptyProcess || session.status !== 'running') return false;
    try {
      session.ptyProcess.resize(cols, rows);
      return true;
    } catch (err) {
      console.error('PTY resize failed:', err instanceof Error ? err.message : err);
      return false;
    }
  }

  // closeSession：主动关闭会话并从 sessions 中移除；已结束的会话只清 Map 残留。
  function closeSession(sessionId, reason = 'active_close') {
    const session = sessions.get(sessionId);
    if (!session) return false;
    if (session.status !== 'running') {
      sessions.delete(sessionId);
      return true;
    }
    return finishRunningSession(session, reason, { remove: true, kill: true });
  }

  // getActiveSessions：列出全部仍处于 running 状态的可序列化会话，给 /api/session/list 等接口使用。
  function getActiveSessions() {
    return Array.from(sessions.values())
      .filter((session) => session.status === 'running')
      .map(serializeSession);
  }

  function startSweeper() {
    // PTY 回收已改为最后连接断开后的 per-session grace timer；不再按输入时间清理。
  }

  function touchSession() {
    // 输入不再作为存活依据；保留兼容导出，避免协议层重新引入输入驱动保活。
  }

  function getPreview(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return null;
    return session.ringBuffer.join('\n');
  }

  // getOutputSnapshot：按 lastOffset 之后的输出切片返回；请求 offset 早于缓冲起点时返回 OUTPUT_GAP 错误。
  function getOutputSnapshot(sessionId, lastOffset = 0n) {
    const session = sessions.get(sessionId);
    if (!session) {
      return { ok: false, error: { code: 'SESSION_NOT_FOUND', message: '终端会话不存在' } };
    }
    const requested = typeof lastOffset === 'bigint' ? lastOffset : BigInt(lastOffset);
    const currentOffset = session.outputOffset;
    const oldestOffset = session.outputChunks.length > 0 ? session.outputChunks[0].startOffset : currentOffset;
    if (requested < oldestOffset) {
      return {
        ok: false,
        error: { code: 'OUTPUT_GAP', message: '终端输出缓冲已被覆盖，请重新打开终端' },
        oldestOffset,
        currentOffset,
      };
    }
    const frames = [];
    for (const chunk of session.outputChunks) {
      const endOffset = chunk.startOffset + BigInt(chunk.payload.length);
      if (endOffset <= requested) continue;
      const sliceStart = requested > chunk.startOffset ? Number(requested - chunk.startOffset) : 0;
      frames.push({
        startOffset: chunk.startOffset + BigInt(sliceStart),
        payload: chunk.payload.subarray(sliceStart),
      });
    }
    return { ok: true, frames, oldestOffset, currentOffset };
  }

  return {
    createSession,
    getSession,
    getPtyProcess,
    writeToSession,
    resize,
    closeSession,
    dispose: (sessionId) => closeSession(sessionId, 'dispose'),
    killSession: (sessionId) => closeSession(sessionId, 'active_close'),
    attachSession,
    detachSession,
    addSessionListener: attachSession,
    removeSessionListener: detachSession,
    getActiveSessions,
    startSweeper,
    touchSession,
    getPreview,
    getOutputSnapshot,
  };
}

const defaultManager = createPtyManager();

export const createSession = defaultManager.createSession;
export const getSession = defaultManager.getSession;
export const getPtyProcess = defaultManager.getPtyProcess;
export const writeToSession = defaultManager.writeToSession;
export const resize = defaultManager.resize;
export const dispose = defaultManager.dispose;
export const killSession = defaultManager.killSession;
export const attachSession = defaultManager.attachSession;
export const detachSession = defaultManager.detachSession;
export const addSessionListener = defaultManager.addSessionListener;
export const removeSessionListener = defaultManager.removeSessionListener;
export const getActiveSessions = defaultManager.getActiveSessions;
export const startSweeper = defaultManager.startSweeper;
export const touchSession = defaultManager.touchSession;
export const getPreview = defaultManager.getPreview;
export const getOutputSnapshot = defaultManager.getOutputSnapshot;

const ptyManager = {
  createSession,
  getSession,
  getPtyProcess,
  writeToSession,
  resize,
  dispose,
  killSession,
  attachSession,
  detachSession,
  addSessionListener,
  removeSessionListener,
  getActiveSessions,
  spawnCommand,
  canResolveCommand,
  resolveSpawnConfig,
  startSweeper,
  touchSession,
  getPreview,
  getOutputSnapshot,
};

export default ptyManager;
