/**
 * nterminal 自定义服务。
 * - 左侧终端保持原始 PTY 交互
 * - 右侧面板和本地日志只记录语义级输入/回复
 * - 路径入口、历史页、详情页所需的 HTTP/WS 路由在此收敛
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { parse } from 'node:url';
import next from 'next';
import { WebSocket, WebSocketServer } from 'ws';
import { makePreview } from './server/text-utils.mjs';
import { createTerminalObserver } from './server/terminal-observer.mjs';

import {
  addSessionListener,
  createSession,
  getSession,
  removeSessionListener,
  resize,
  writeToSession,
} from './server/pty-manager.mjs';

import {
  beginTurn,
  appendOutput,
  finishTurn,
} from './server/interaction-recorder.mjs';

import {
  validateAndSave,
  list as listPathHistory,
  deletePath,
  clearAll as clearPathHistory,
} from './server/path-history-store.mjs';

import {
  validateCwd,
  validatePath,
  validateQuery,
  checkDirectoryExists,
  readBoundedRequestBody,
} from './server/validation.mjs';

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.HOST || 'localhost';
const port = parseInt(process.env.PORT || '3000', 10);
const LOG_DIR = join(process.cwd(), 'logs');
const DEBUG_LOG_FILE = join(LOG_DIR, 'wterm-poc-debug.log');
const VERBOSE_LOG = process.env.POC_VERBOSE_LOG === '1';
const REPLY_IDLE_MS = parseInt(process.env.POC_REPLY_IDLE_MS || '1800', 10);
const OSC_DEBOUNCE_MS = parseInt(process.env.POC_OSC_DEBOUNCE_MS || '300', 10);
const OSC_STALE_MS = parseInt(process.env.POC_OSC_STALE_MS || '5000', 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();
const sessionObservers = new Map();
const activeRecords = new Map(); // sessionId -> recordId

function writeLog(event, data = {}) {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    pid: process.pid,
    event,
    ...data,
  });
  mkdirSync(LOG_DIR, { recursive: true });
  appendFileSync(DEBUG_LOG_FILE, `${line}\n`, 'utf-8');
  console.log(`[POC] ${event}`, data);
}

function verboseLog(event, data = {}) {
  if (VERBOSE_LOG) writeLog(event, data);
}

function readRequestBody(req) {
  // 1MiB 上限由 readBoundedRequestBody 强制；保留别名以兼容
  return readBoundedRequestBody(req);
}

function errorResponse(res, status, code, message) {
  sendJson(res, status, { ok: false, error: { code, message } });
}

// 把 validation result 转为 HTTP 错误响应；result.ok=false 时写入响应并返回 true
function handleValidationError(res, result) {
  if (result.ok) return false;
  const status = result.code === 'body_too_large' ? 413
    : result.code === 'unc_not_allowed' || result.code === 'path_too_long' || result.code === 'query_too_long' || result.code === 'query_empty' || result.code === 'invalid_cwd' || result.code === 'invalid_path' || result.code === 'query_invalid' ? 400
    : result.code === 'directory_not_found' || result.code === 'path_not_directory' ? 400
    : 400;
  errorResponse(res, status, result.code, result.message);
  return true;
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const body = await readRequestBody(req);
  if (!body) return null;
  try { return JSON.parse(body); }
  catch { return null; }
}

function createObserver(sessionId, ws, sessionMeta) {
  // P1b：terminal-observer 持有 turn 状态机（OSC 133 + 去抖 + alt-screen 隔离）。
  // onFinalize 回调在回复 finalize 时触发（OSC 去抖或 idle 兜底），录 agent_reply + finishTurn。
  // 用 observer 闭包延迟绑定（terminal 需要 onFinalize，onFinalize 需要 observer）。
  const observer = {
    sessionId,
    ws,
    cwd: sessionMeta?.cwd || '',
    command: sessionMeta?.command || '',
    userBuffer: '',
    hasUserMessage: false,
    recordId: null,
    recordFinalized: false,
    terminal: null,
  };
  observer.terminal = createTerminalObserver({
    cols: 80,
    rows: 24,
    idleMs: REPLY_IDLE_MS,
    debounceMs: OSC_DEBOUNCE_MS,
    staleMs: OSC_STALE_MS,
    onFinalize: (text, reason) => onReplyFinalize(observer, text, reason),
  });
  return observer;
}

function finalizeRecord(observer, endState, error = null) {
  if (observer.recordFinalized) return;
  observer.recordFinalized = true;
  const recordId = activeRecords.get(observer.sessionId);
  if (!recordId) return;
  try {
    finishTurn(recordId, { endState, error });
  } catch (err) {
    writeLog('finish_turn_failed', {
      sessionId: observer.sessionId,
      recordId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
  activeRecords.delete(observer.sessionId);
  observer.recordId = null;
}

function observeInput(observer, input) {
  // P1b：不再用 oscDetected 分支。用户输入字符即 prompt 文本（pi raw 模式不回显，
  // 但 observeInput 看到的是 client→PTY 的原始按键），直接捕获为 user 文本。
  // 过滤控制/转义序列，处理退格。role 标注的难点在 assistant 回复侧（P1d），与 user 输入无关。
  for (const char of input) {
    if (char === '\r' || char === '\n') {
      flushUserMessage(observer);
      continue;
    }
    if (char === '\b' || char === '\x7f') {
      observer.userBuffer = observer.userBuffer.slice(0, -1);
      continue;
    }
    if (char >= ' ' && char !== '\x1b') {
      observer.userBuffer += char;
    }
  }
}

function flushUserMessage(observer) {
  const text = observer.userBuffer.trim();
  observer.userBuffer = '';
  if (!text) return;

  // 收敛前一个未结束的 record
  if (observer.recordFinalized === false && activeRecords.has(observer.sessionId)) {
    finalizeRecord(observer, 'session_exit', 'superseded');
  }

  observer.hasUserMessage = true;

  const recordId = beginTurn({
    sessionId: observer.sessionId,
    cwd: observer.cwd,
    command: observer.command,
    userText: text,
  });
  activeRecords.set(observer.sessionId, recordId);
  observer.recordId = recordId;
  observer.recordFinalized = false;

  // P1b：开新 turn，复位 OSC 计数（aCount/zoneStart），告知 terminal-observer 等待回复 finalize。
  observer.terminal.setHasUserTurn(true);

  writeLog('user_message', { type: 'user_message', sessionId: observer.sessionId, text, recordId, bytes: Buffer.byteLength(text, 'utf-8') });
}

function observeOutput(observer, output) {
  // PTY 输出旁路喂 headless grid（差分渲染可见文本还原 + OSC 133 turn 状态机）。
  // 不论 hasUserMessage 都喂，保证 grid 始终与真实终端同步（resize/重绘/alt-screen 都要进 grid）。
  observer.terminal.feed(output);

  if (!observer.hasUserMessage) return;

  // appendOutput 保留原始字节供搜索/重放；可见文本还原走 grid snapshot，不依赖此内容。
  const recordId = activeRecords.get(observer.sessionId);
  if (recordId) {
    try { appendOutput(recordId, output); }
    catch (err) {
      writeLog('append_output_failed', { sessionId: observer.sessionId, message: err instanceof Error ? err.message : String(err) });
    }
  }
}

// P1b/P1e：terminal-observer 在回复 finalize（OSC 去抖或 idle 兜底）时回调此函数。
// payload = { assistantText, userTextFromOsc, role }。
//   - assistantText：grid snapshot 还原的回复可见文本（录 agent_reply）
//   - userTextFromOsc：OSC A..B 捕获的 user 文本（P1e，pi 渲染的真实 user 文本，校准信号）
//   - role：'assistant'(OSC) | 'mixed'(idle 合录)
// 用 userTextFromOsc 与 observeInput 的 userText 比对，记校准日志；observeInput 为空时 fallback 录。
function onReplyFinalize(observer, payload, reason) {
  const { assistantText, userTextFromOsc, role } = payload || {};
  if (assistantText) {
    writeLog('agent_reply', { type: 'agent_reply', sessionId: observer.sessionId, text: assistantText, bytes: Buffer.byteLength(assistantText, 'utf-8'), reason, role });
  } else {
    writeLog('agent_reply_empty', { sessionId: observer.sessionId, reason, role });
  }
  // P1e：user 文本双源校准。observeInput 按键直捕 vs OSC A..B 渲染文本。
  // 不改 record 结构（userText 已在 beginTurn 录），仅记校准日志供 P1f 决定是否切主源。
  if (userTextFromOsc) {
    writeLog('user_text_osc', { sessionId: observer.sessionId, text: userTextFromOsc, bytes: Buffer.byteLength(userTextFromOsc, 'utf-8'), role });
  }
  const endState = (reason === 'pty_exit' || reason === 'ws_closed') ? 'session_exit' : 'idle';
  finalizeRecord(observer, endState, null);
  observer.hasUserMessage = false;
  observer.terminal?.setHasUserTurn(false);
}

app.prepare().then(() => {
  writeLog('server_ready', { dev, hostname, port, cwd: process.cwd(), verboseLog: VERBOSE_LOG });

  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url || '/', true);
      verboseLog('http_request', { method: req.method, pathname: parsedUrl.pathname });

      if (parsedUrl.pathname.startsWith('/api/')) {
        if (req.method !== 'POST' && (parsedUrl.pathname.startsWith('/api/records/') || parsedUrl.pathname.startsWith('/api/path-history/'))) {
          errorResponse(res, 405, 'method_not_allowed', '只允许 POST 方法');
          return;
        }
        if (req.method === 'POST') {
          switch (parsedUrl.pathname) {
            case '/api/session/create':
              await handleCreateSession(req, res);
              return;
            case '/api/directory/validate':
              await handleDirectoryValidate(req, res);
              return;
            case '/api/path-history/list':
              await handlePathHistoryList(req, res);
              return;
            case '/api/path-history/save':
              await handlePathHistorySave(req, res);
              return;
            case '/api/path-history/delete':
              await handlePathHistoryDelete(req, res);
              return;
            case '/api/path-history/clear':
              await handlePathHistoryClear(req, res);
              return;
            case '/api/records/list':
              await handleRecordsList(req, res);
              return;
            case '/api/records/search':
              await handleRecordsSearch(req, res);
              return;
            case '/api/records/detail':
              await handleRecordsDetail(req, res);
              return;
            default:
              break;
          }
        }
      }
      await handle(req, res, parsedUrl);
    } catch (err) {
      if (err && err.code === 'body_too_large') {
        if (!res.headersSent) {
          sendJson(res, 413, { ok: false, error: { code: 'body_too_large', message: '请求体过大（上限 1MiB）' } });
        }
        return;
      }
      writeLog('http_error', { message: err instanceof Error ? err.message : String(err) });
      sendJson(res, 500, { ok: false, error: { code: 'internal_error', message: '服务器内部错误' } });
    }
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = parse(req.url || '/', true);
    const match = pathname?.match(/^\/ws\/pty\/([^/]+)$/);
    verboseLog('ws_upgrade', { pathname, matched: Boolean(match) });

    if (!match) {
      app.getUpgradeHandler()(req, socket, head);
      return;
    }

    const sessionId = match[1];
    const session = getSession(sessionId);
    if (!session) {
      writeLog('ws_upgrade_rejected', { sessionId, reason: 'session_not_found' });
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    if (session.status !== 'running') {
      writeLog('ws_upgrade_rejected', { sessionId, reason: 'session_not_running', status: session.status });
      socket.write('HTTP/1.1 409 Conflict\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, sessionId);
    });
  });

  wss.on('connection', (ws, req, sessionId) => {
    bindPtyWebSocket(ws, sessionId);
  });

  server.listen(port, hostname, () => {
    writeLog('server_listen', { url: `http://${hostname}:${port}` });
    console.log(`> Ready on http://${hostname}:${port}`);
  });
});

async function handleCreateSession(req, res) {
  const body = await readJsonBody(req);
  const cwd = body?.cwd;
  // cwd 可选（缺省用 process.cwd），但传了就必须合法
  if (cwd !== undefined && cwd !== null) {
    if (handleValidationError(res, validateCwd(cwd))) return;
  }
  const result = createSession({ cwd: cwd || process.cwd() });
  writeLog('session_created', {
    id: result.id, status: result.status, command: result.command, cwd: result.cwd,
    error: result.error || null,
  });
  if (result.status === 'error') {
    // 失败响应壳统一为 {ok:false, error:{code,message}}，不再附带 data.session
    errorResponse(res, 500, 'spawn_failed', result.error || '创建 PTY 会话失败');
    return;
  }
  sendJson(res, 200, { ok: true, data: result });
}

async function handleDirectoryValidate(req, res) {
  const body = await readJsonBody(req);
  const candidate = body?.path;
  // 兼容旧字段 cwd（设计 3.4 用 cwd 字段名）
  const value = candidate ?? body?.cwd;
  if (typeof value !== 'string' || !value) {
    errorResponse(res, 400, 'invalid_path', 'path 必须是非空字符串');
    return;
  }
  if (handleValidationError(res, validateCwd(value))) return;
  const exists = checkDirectoryExists(value);
  if (!exists.ok) {
    // checkDirectoryExists 已带 directory_not_found / path_not_directory
    handleValidationError(res, exists);
    return;
  }
  // 设计 3.4：data = { ok, cwd?, displayName?, error? }
  sendJson(res, 200, {
    ok: true,
    data: {
      ok: true,
      cwd: exists.resolved,
      displayName: exists.displayName,
    },
  });
}

async function handlePathHistoryList(req, res) {
  const body = await readJsonBody(req);
  const limit = Math.min(Math.max(parseInt(body?.limit ?? 50, 10) || 50, 1), 50);
  try {
    const r = await listPathHistory({ limit });
    sendJson(res, 200, { ok: true, data: r });
  } catch (err) {
    errorResponse(res, 500, 'list_failed', err instanceof Error ? err.message : String(err));
  }
}

async function handlePathHistorySave(req, res) {
  const body = await readJsonBody(req);
  if (handleValidationError(res, validatePath(body?.path))) return;
  try {
    const r = await validateAndSave({ path: body.path });
    sendJson(res, 200, { ok: true, data: r });
  } catch (err) {
    // save 失败可能是目录已被删等 → 区分 directory_not_found / path_not_directory
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('路径验证失败') || msg.includes('目录')) {
      errorResponse(res, 400, 'directory_not_found', msg);
    } else {
      errorResponse(res, 400, 'save_failed', msg);
    }
  }
}

async function handlePathHistoryDelete(req, res) {
  const body = await readJsonBody(req);
  if (handleValidationError(res, validatePath(body?.path))) return;
  try {
    const r = await deletePath({ path: body.path });
    sendJson(res, 200, { ok: true, data: r });
  } catch (err) {
    errorResponse(res, 400, 'delete_failed', err instanceof Error ? err.message : String(err));
  }
}

async function handlePathHistoryClear(req, res) {
  try {
    const r = await clearPathHistory();
    sendJson(res, 200, { ok: true, data: r });
  } catch (err) {
    errorResponse(res, 500, 'clear_failed', err instanceof Error ? err.message : String(err));
  }
}

async function handleRecordsList(req, res) {
  const body = await readJsonBody(req);
  if (handleValidationError(res, validateQuery(body?.query))) return;
  if (body?.cwd !== undefined && body.cwd !== null) {
    if (handleValidationError(res, validatePath(body.cwd, 'cwd'))) return;
  }
  try {
    const { listRecords } = await import('./server/interaction-recorder.mjs');
    const r = listRecords({
      query: body?.query || '',
      cwd: body?.cwd || null,
      sessionId: body?.sessionId || null,
      limit: Math.min(Math.max(parseInt(body?.limit ?? 20, 10) || 20, 1), 50),
      offset: Math.max(parseInt(body?.offset ?? 0, 10) || 0, 0),
    });
    sendJson(res, 200, { ok: true, data: r });
  } catch (err) {
    errorResponse(res, 500, 'list_failed', err instanceof Error ? err.message : String(err));
  }
}

async function handleRecordsSearch(req, res) {
  const body = await readJsonBody(req);
  // 设计 C-001：search 必须有 query；空 query 返 400 + query_empty
  if (handleValidationError(res, validateQuery(body?.query, { required: true }))) return;
  if (body && body.scope && body.scope !== 'global') {
    errorResponse(res, 400, 'scope_invalid', 'scope 必须为 "global"');
    return;
  }
  try {
    const { searchRecords } = await import('./server/interaction-recorder.mjs');
    const r = searchRecords({
      query: body.query,
      limit: Math.min(Math.max(parseInt(body?.limit ?? 20, 10) || 20, 1), 50),
    });
    sendJson(res, 200, { ok: true, data: r });
  } catch (err) {
    errorResponse(res, 500, 'search_failed', err instanceof Error ? err.message : String(err));
  }
}

async function handleRecordsDetail(req, res) {
  const body = await readJsonBody(req);
  if (typeof body?.recordId !== 'string' || !body.recordId) {
    errorResponse(res, 400, 'invalid_recordId', 'recordId 必须是非空字符串');
    return;
  }
  try {
    const { getRecordById } = await import('./server/interaction-recorder.mjs');
    const r = getRecordById(body.recordId);
    if (!r) {
      errorResponse(res, 404, 'not_found', `记录 ${body.recordId} 不存在`);
      return;
    }
    sendJson(res, 200, { ok: true, data: { record: r } });
  } catch (err) {
    errorResponse(res, 500, 'detail_failed', err instanceof Error ? err.message : String(err));
  }
}

function bindPtyWebSocket(ws, sessionId) {
  writeLog('ws_connected', { sessionId });
  const sessionMeta = getSession(sessionId);
  const observer = createObserver(sessionId, ws, sessionMeta);
  sessionObservers.set(sessionId, observer);

  const ptyListener = (event) => {
    if (event.type === 'data') {
      verboseLog('pty_output_chunk', {
        sessionId,
        bytes: Buffer.byteLength(event.data, 'utf-8'),
        preview: makePreview(event.data, 'output'),
      });
      observeOutput(observer, event.data);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(Buffer.from(event.data, 'utf-8'));
      }
      return;
    }
    if (event.type === 'exit') {
      // P1b：兜底密封 = Warp TerminalModel::exit。先 flushNow 抓取未 finalize 的回复
      // （OSC 去抖可能还 pending），再 finishTurn，再释放 grid。
      observer.terminal?.flushNow('pty_exit');
      finalizeRecord(observer, 'session_exit', 'pty_exit');
      observer.terminal.dispose();   // 释放 headless grid
      writeLog('session_exit', { sessionId, exitCode: event.exitCode, signal: event.signal });
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(`\r\n\x1b[90m[session exited (code ${event.exitCode})]\x1b[0m\r\n`);
      }
    }
  };

  addSessionListener(sessionId, ptyListener);

  ws.on('message', async (message, isBinary) => {
    try {
      const input = messageToTerminalInput(message);
      verboseLog('ws_message', {
        sessionId, isBinary, bytes: input.bytes,
        preview: makePreview(input.text, 'user'),
      });

      if (!isBinary && maybeHandleControlMessage(ws, sessionId, input.text)) {
        return;
      }

      observeInput(observer, input.text);
      writeRawInput(ws, sessionId, input.text, input.bytes);
    } catch (err) {
      writeLog('ws_message_error', { sessionId, message: err instanceof Error ? err.message : String(err) });
    }
  });

  ws.on('close', () => {
    observer.terminal?.flushNow('ws_closed');
    finalizeRecord(observer, 'session_exit', 'ws_closed');
    observer.terminal.dispose();   // 释放 headless grid
    writeLog('ws_closed', { sessionId });
    removeSessionListener(sessionId, ptyListener);
    sessionObservers.delete(sessionId);
  });

  ws.on('error', (err) => {
    finalizeRecord(observer, 'error', err instanceof Error ? err.message : String(err));
    writeLog('ws_error', { sessionId, message: err instanceof Error ? err.message : String(err) });
  });
}

function messageToTerminalInput(message) {
  if (Buffer.isBuffer(message)) {
    return { text: message.toString('utf-8'), bytes: message.length };
  }
  const text = String(message);
  return { text, bytes: Buffer.byteLength(text, 'utf-8') };
}

function maybeHandleControlMessage(ws, sessionId, text) {
  let envelope;
  try { envelope = JSON.parse(text); }
  catch { return false; }
  if (!envelope || typeof envelope !== 'object') return false;
  const ctrl = envelope._ctrl;
  if (!ctrl || typeof ctrl !== 'object') return false;
  if (ctrl.type === 'resize') {
    const ok = resize(sessionId, ctrl.cols, ctrl.rows);
    // P1a：同步 headless grid 尺寸，否则 pi 按真实宽度算的 cursor-up 行数与 grid 错位 → snapshot 乱行。
    if (ok) {
      try { sessionObservers.get(sessionId)?.terminal?.resize(ctrl.cols, ctrl.rows); }
      catch (err) { writeLog('grid_resize_failed', { sessionId, cols: ctrl.cols, rows: ctrl.rows, message: err instanceof Error ? err.message : String(err) }); }
    }
    verboseLog('resize', { sessionId, cols: ctrl.cols, rows: ctrl.rows, ok });
    if (!ok) writeLog('resize_failed', { sessionId, cols: ctrl.cols, rows: ctrl.rows });
    return true;
  }
  return false;
}

function writeRawInput(ws, sessionId, input, bytes) {
  const ok = writeToSession(sessionId, input);
  if (!ok) {
    writeLog('pty_write_failed', { sessionId, bytes, input: makePreview(input, 'user') });
  }
}


