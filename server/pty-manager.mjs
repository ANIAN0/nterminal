/**
 * PTY manager.
 * Spawns real terminal sessions via node-pty with user-specified cwd.
 *
 * 设计 C-003：
 *   - 默认走 spawnInteractiveShell（用户 cwd 启动系统默认 shell）
 *   - 保留 spawnCommand / canResolveCommand / resolveSpawnConfig / firstCommandToken / isWindowsBuiltin
 *     供后续命令式 TUI 入口；本期不挂 HTTP
 *   - createSession 入口先做 cwd 合法性校验，失败直接 createFailedSession
 */

import pty from 'node-pty';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { validateCwd, checkDirectoryExists } from './validation.mjs';

const sessions = new Map();

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

// 缓存 Windows shell 解析结果（进程内）
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
  for (const c of candidates) {
    const resolved = whichOnPath(c);
    if (resolved) {
      resolvedWindowsShell = resolved;
      return resolved;
    }
  }
  resolvedWindowsShell = process.env.COMSPEC || 'cmd.exe';
  return resolvedWindowsShell;
}

function shellConfig() {
  if (process.platform === 'win32') {
    const file = resolveWindowsShell();
    const base = (file.split(/[\\/]/).pop() || '').toLowerCase();
    // PowerShell 用 -NoLogo；cmd 用 /d
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

function defaultShellCommand() {
  if (process.platform === 'win32') {
    const file = resolveWindowsShell();
    const base = (file.split(/[\\/]/).pop() || '').toLowerCase();
    return base.startsWith('powershell') || base.startsWith('pwsh') ? base : 'cmd.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

function createFailedSession(sessionId, cwd, command, error) {
  const now = new Date().toISOString();
  sessions.set(sessionId, {
    id: sessionId,
    cwd,
    command,
    status: 'error',
    startedAt: now,
    endedAt: now,
    exitCode: null,
    signal: null,
    error,
    ptyProcess: null,
    listeners: new Set(),
  });

  return {
    id: sessionId,
    cwd,
    command,
    status: 'error',
    error,
    startedAt: now,
  };
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
 * 命令式 spawn：执行单条命令（保留供后续 TUI 入口；本期不挂 HTTP）
 * Windows: cmd.exe /d /s /c <command>
 * 非 Windows: bash -lc <command>
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

function firstCommandToken(command) {
  if (typeof command !== 'string') return '';
  const trimmed = command.trim();
  if (!trimmed) return '';
  // 取第一个 token（按空格 / tab 切）
  return trimmed.split(/\s+/)[0] || '';
}

function isWindowsBuiltin(token) {
  if (!token) return false;
  const t = token.toLowerCase();
  // Windows CMD 内建命令常见集
  const builtins = new Set([
    'dir', 'cd', 'copy', 'move', 'del', 'rd', 'rmdir', 'md', 'mkdir', 'ren', 'rename',
    'type', 'echo', 'set', 'setlocal', 'endlocal', 'if', 'for', 'goto', 'call',
    'cls', 'exit', 'pushd', 'popd', 'start', 'tasklist', 'taskkill', 'where', 'help',
  ]);
  return builtins.has(t);
}

/**
 * 是否能直接 resolve 出一个可执行路径（即不需要 shell 求值）。
 * 简单的判定：含路径分隔符、或在 PATH/常见 bin 目录下。
 * 本期不挂 HTTP，仅作为未来 TUI 入口的预判逻辑保留。
 */
export function canResolveCommand(command) {
  const token = firstCommandToken(command);
  if (!token) return false;
  if (token.includes('/') || token.includes('\\')) return true;
  if (process.platform === 'win32' && /^[A-Za-z]:[\\/]/.test(token)) return true;
  if (isWindowsBuiltin(token)) return true;
  // 简化：假定 PATH 中能找到（实际由 spawn 失败兜底）
  return true;
}

/**
 * 根据平台把字符串 command 解析成 spawn 的 file/args。
 * Windows: { file: cmd.exe, args: ['/d','/s','/c', command] }
 * 非 Windows: { file: bash, args: ['-lc', command] }
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

export function createSession({ cwd, cols = 80, rows = 24, tagLabel = null } = {}) {
  const sessionId = randomUUID();
  const command = defaultShellCommand();

  // 设计 C-003：cwd 入口先做合法性校验
  let resolvedCwd;
  if (cwd !== undefined && cwd !== null) {
    const valid = validateCwd(cwd);
    if (!valid.ok) {
      return createFailedSession(sessionId, cwd, command, valid.message);
    }
    const exists = checkDirectoryExists(cwd);
    if (!exists.ok) {
      return createFailedSession(sessionId, cwd, command, exists.message);
    }
    resolvedCwd = exists.resolved;
  } else {
    resolvedCwd = process.cwd();
  }

  try {
    const ptyProcess = spawnInteractiveShell({ cwd: resolvedCwd, cols, rows });

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
      lastSeenAt: Date.now(),
      listeners: new Set(),
    };

    ptyProcess.onExit(({ exitCode, signal }) => {
      session.status = 'ended';
      session.endedAt = new Date().toISOString();
      session.exitCode = exitCode;
      session.signal = signal;

      for (const listener of session.listeners) {
        try {
          listener({ type: 'exit', exitCode, signal });
        } catch (err) {
          console.error('Session listener error:', err instanceof Error ? err.message : err);
        }
      }
    });

    ptyProcess.onData((data) => {
      session.outputBuffer += data;

      // 写入 ring buffer（保留最近 100 行）
      const lines = data.split('\n');
      for (const line of lines) {
        if (line) {
          session.ringBuffer.push(line);
          if (session.ringBuffer.length > 100) {
            session.ringBuffer.shift();
          }
        }
      }

      for (const listener of session.listeners) {
        try {
          listener({ type: 'data', data });
        } catch (err) {
          console.error('Session listener error:', err instanceof Error ? err.message : err);
        }
      }
    });

    sessions.set(sessionId, session);

    return {
      id: sessionId,
      cwd: resolvedCwd,
      command,
      tagLabel: session.tagLabel,
      status: 'running',
      startedAt: session.startedAt,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return createFailedSession(sessionId, resolvedCwd, command, message);
  }
}

export function getSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    return null;
  }

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

export function getPtyProcess(sessionId) {
  return sessions.get(sessionId)?.ptyProcess || null;
}

export function writeToSession(sessionId, data) {
  const session = sessions.get(sessionId);
  if (!session || !session.ptyProcess || session.status !== 'running') {
    return false;
  }

  try {
    session.ptyProcess.write(data);
    return true;
  } catch (err) {
    console.error('PTY write failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

export function resize(sessionId, cols, rows) {
  const session = sessions.get(sessionId);
  if (!session || !session.ptyProcess || session.status !== 'running') {
    return false;
  }

  try {
    session.ptyProcess.resize(cols, rows);
    return true;
  } catch (err) {
    console.error('PTY resize failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

export function dispose(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    return false;
  }

  try {
    if (session.ptyProcess && session.status === 'running') {
      session.ptyProcess.kill();
    }

    session.status = 'ended';
    session.endedAt = new Date().toISOString();
    sessions.delete(sessionId);
    return true;
  } catch (err) {
    console.error('Session dispose failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * killSession：dispose 的语义别名（更贴近用户视角）。
 * 关闭 PTY 进程、从 Map 删除，幂等。
 */
export const killSession = dispose;

export function addSessionListener(sessionId, listener) {
  const session = sessions.get(sessionId);
  if (!session) {
    return false;
  }

  session.listeners.add(listener);
  return true;
}

export function removeSessionListener(sessionId, listener) {
  const session = sessions.get(sessionId);
  if (!session) {
    return false;
  }

  session.listeners.delete(listener);
  return true;
}

export function getActiveSessions() {
  return Array.from(sessions.values())
    .filter((session) => session.status === 'running')
    .map((session) => ({
      id: session.id,
      cwd: session.cwd,
      command: session.command,
      tagLabel: session.tagLabel || null,
      status: session.status,
      startedAt: session.startedAt,
    }));
}

let sweeperTimer = null;

/**
 * 启动 PTY 清理定时器：每 30s 扫一次，kill 60s 无 WS 连接的 PTY。
 * @param {number} intervalMs - 扫描间隔（毫秒），默认 30000
 * @param {number} ttlMs - 无连接超时（毫秒），默认 60000
 */
export function startSweeper(intervalMs = 30000, ttlMs = 60000) {
  if (sweeperTimer) return;

  sweeperTimer = setInterval(() => {
    const now = Date.now();
    for (const session of sessions.values()) {
      if (session.status !== 'running') continue;
      if (now - session.lastSeenAt > ttlMs) {
        // 超时，kill PTY
        try {
          if (session.ptyProcess) session.ptyProcess.kill();
          session.status = 'ended';
          session.endedAt = new Date().toISOString();
        } catch { /* ignore */ }
      }
    }
  }, intervalMs);

  if (sweeperTimer.unref) sweeperTimer.unref();
}

/**
 * 更新 session 的 lastSeenAt。
 * @param {string} sessionId
 */
export function touchSession(sessionId) {
  const session = sessions.get(sessionId);
  if (session) session.lastSeenAt = Date.now();
}

/**
 * 获取 session 的 ring buffer 内容。
 * @param {string} sessionId
 * @returns {string|null} 最近 100 行输出，不存在返回 null
 */
export function getPreview(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  return session.ringBuffer.join('\n');
}

const ptyManager = {
  createSession,
  getSession,
  getPtyProcess,
  writeToSession,
  resize,
  dispose,
  killSession,
  addSessionListener,
  removeSessionListener,
  getActiveSessions,
  spawnCommand,
  canResolveCommand,
  resolveSpawnConfig,
  startSweeper,
  touchSession,
  getPreview,
};

export default ptyManager;
