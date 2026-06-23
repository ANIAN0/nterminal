/**
 * nterminal 自定义服务。
 * - 左侧终端保持原始 PTY 交互
 * - 右侧面板和本地日志只记录语义级输入/回复
 * - 路径入口、历史页、详情页所需的 HTTP/WS 路由在此收敛
 */


import { createServer } from 'node:http';
import { join } from 'node:path';
import { parse } from 'node:url';
import next from 'next';
import { WebSocket, WebSocketServer } from 'ws';
import { createTerminalObserver } from './server/terminal-observer.mjs';

import {
  addSessionListener,
  createSession,
  getSession,
  getOutputSnapshot,
  killSession,
  removeSessionListener,
  resize,
  writeToSession,
  getActiveSessions,
} from './server/pty-manager.mjs';
import { startSweeper, touchSession, getPreview } from './server/pty-manager.mjs';
import { encodeEnvelope, encodeOutputFrame, parseControlEnvelope } from './server/terminal-protocol.mjs';

import {
  validateCwd,
  validatePath,
  validateQuery,
  checkDirectoryExists,
  readBoundedRequestBody,
} from './server/validation.mjs';

import { initializeDatabase, getDb, getSchemaVersion } from './server/database.mjs';
import {
  insertConversationSource,
  listConversationSources,
  deleteConversationSource as dbDeleteConversationSource,
  queryCompletion as dbQueryCompletion,
} from './server/database.mjs';
import { createImportEngine } from './server/conversation-import.mjs';
import { discoverDefaultSources } from './server/startup-discovery.mjs';
import { createWorkspaceService, WorkspaceServiceError } from './server/workspace-service.mjs';
import { HistoryServiceError, getHistorySession, listHistorySessions } from './server/history-service.mjs';
import { createLogger } from './server/logger.mjs';
import { getHealthStatus } from './server/health-service.mjs';

// 导入引擎实例（启动流程中初始化，sync API 复用）
let importEngine = null;
let workspaceService = null;
/** @returns {ReturnType<typeof createImportEngine> | null} */
export function getImportEngine() {
  return importEngine;
}

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.HOST || 'localhost';
const port = parseInt(process.env.PORT || '3000', 10);
const LOG_DIR = join(process.cwd(), 'logs');
const VERBOSE_LOG = process.env.POC_VERBOSE_LOG === '1';
const REPLY_IDLE_MS = parseInt(process.env.POC_REPLY_IDLE_MS || '1800', 10);
const OSC_DEBOUNCE_MS = parseInt(process.env.POC_OSC_DEBOUNCE_MS || '300', 10);
const OSC_STALE_MS = parseInt(process.env.POC_OSC_STALE_MS || '5000', 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();
const sessionObservers = new Map();
const logger = createLogger({ logDir: LOG_DIR });

function writeLog(event, data = {}) {
  logger.write(event, data);
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
  const observer = {
    sessionId,
    ws,
    cwd: sessionMeta?.cwd || '',
    command: sessionMeta?.command || '',
    userBuffer: '',
    hasUserMessage: false,
    terminal: null,
  };
  observer.terminal = createTerminalObserver({
    cols: 80,
    rows: 24,
    idleMs: REPLY_IDLE_MS,
    debounceMs: OSC_DEBOUNCE_MS,
    staleMs: OSC_STALE_MS,
    onFinalize: (text, reason) => {
      writeLog('reply_finalized', { sessionId, reason, textLength: text.length });
    },
  });
  return observer;
}

function observeInput(observer, input) {
  for (const char of input) {
    if (char === '\r' || char === '\n') {
      const text = observer.userBuffer.trim();
      observer.userBuffer = '';
      if (text) {
        observer.hasUserMessage = true;
        // 只记录输入字节数，不记录命令正文，避免诊断日志成为敏感数据副本。
        writeLog('user_message', { sessionId: observer.sessionId, bytes: Buffer.byteLength(text, 'utf-8') });
        observer.terminal?.setHasUserTurn(true);
      }
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

function observeOutput(observer, output) {
  observer.terminal?.feed(output);
}

function addObserver(sessionId, observer) {
  if (!sessionObservers.has(sessionId)) sessionObservers.set(sessionId, new Set());
  sessionObservers.get(sessionId).add(observer);
}

function removeObserver(sessionId, observer) {
  const observers = sessionObservers.get(sessionId);
  if (!observers) return;
  observers.delete(observer);
  if (observers.size === 0) sessionObservers.delete(sessionId);
}

function parseLastOffset(req) {
  const query = parse(req.url || '', true).query;
  const raw = Array.isArray(query.lastOffset) ? query.lastOffset[0] : query.lastOffset;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return 0n;
  return BigInt(raw);
}

function sendTerminalEnvelope(ws, message) {
  if (ws.readyState === WebSocket.OPEN) ws.send(encodeEnvelope(message));
}

function sendTerminalOutput(ws, startOffset, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(encodeOutputFrame(startOffset, payload), { binary: true });
}

app.prepare().then(() => {
  // 鍒濆鍖?SQLite 鏁版嵁搴擄紱鏀寔 DATA_DIR 鐜鍙橀噺瑕嗙洊锛堟祴璇曠敤锛?
  const dbPath = process.env.DATA_DIR
    ? join(process.env.DATA_DIR, 'nterminal.db')
    : join(process.cwd(), 'data', 'nterminal.db');
  initializeDatabase(dbPath);
  workspaceService = createWorkspaceService({ db: getDb(), createPty: createSession, closePty: killSession });

  // 首次启动自动发现默认对话源。
  discoverDefaultSources(getDb());

  // 创建导入引擎：定时同步（1h）+ fs.watch 文件变更触发
  // 设计 C-001/C-013：startup → initializeDatabase → syncAll → startScheduler → startWatcher
  importEngine = createImportEngine({ db: getDb() });
  importEngine.startScheduler();
  importEngine.startWatcher();

  // 启动 PTY 清理定时器（30s 扫一次，60s 无连接 kill）
  startSweeper();

  writeLog('server_ready', { dev, hostname, port, verboseLog: VERBOSE_LOG });

  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url || '/', true);
      verboseLog('http_request', { method: req.method, pathname: parsedUrl.pathname });

      if (parsedUrl.pathname.startsWith('/api/')) {
        if (parsedUrl.pathname === '/api/health') {
          if (req.method !== 'GET') { errorResponse(res, 405, 'method_not_allowed', '只允许 GET'); return; }
          const health = getHealthStatus({ getSchemaVersion, getActiveSessions });
          sendJson(res, health.statusCode, { ok: health.statusCode === 200, data: health.body });
          return;
        }
        // conversation-sources 鍏佽 GET/POST/DELETE
        if (parsedUrl.pathname.startsWith('/api/conversation-sources')) {
          await handleConversationSources(req, res, parsedUrl);
          return;
        }
        // workspace/tabs 参数化路由（在 switch 之前拦截）
        if (/^\/api\/workspaces\/[^/]+\/tabs\/list$/.test(parsedUrl.pathname)) {
          if (req.method !== 'POST') { errorResponse(res, 405, 'method_not_allowed', '只允许 POST'); return; }
          await handleTabsList(req, res, parsedUrl);
          return;
        }
        if (/^\/api\/workspaces\/[^/]+\/tabs\/create$/.test(parsedUrl.pathname)) {
          if (req.method !== 'POST') { errorResponse(res, 405, 'method_not_allowed', '只允许 POST'); return; }
          await handleTabsCreate(req, res, parsedUrl);
          return;
        }
        if (/^\/api\/tabs\/[^/]+\/(close|delete)$/.test(parsedUrl.pathname)) {
          if (req.method !== 'POST') { errorResponse(res, 405, 'method_not_allowed', '只允许 POST'); return; }
          await handleTabCommand(req, res, parsedUrl);
          return;
        }
        if (/^\/api\/workspaces\/[^/]+\/tabs\/[^/]+\/preview$/.test(parsedUrl.pathname)) {
          await handleTabPreview(req, res, parsedUrl);
          return;
        }
        // 鍏朵綑 API 鍙厑璁?POST
        if (req.method !== 'POST') {
          errorResponse(res, 405, 'method_not_allowed', '只允许 POST 方法');
          return;
        }
        switch (parsedUrl.pathname) {
            case '/api/directory/validate':
              await handleDirectoryValidate(req, res);
              return;
            case '/api/completion/query':
              await handleCompletionQuery(req, res);
              return;
            case '/api/history/sessions':
              await handleHistorySessions(req, res);
              return;
            case '/api/history/session':
              await handleHistorySession(req, res);
              return;
            case '/api/workspaces/list':
              await handleWorkspacesList(req, res);
              return;
            case '/api/workspaces/create':
              await handleWorkspacesCreate(req, res);
              return;
            case '/api/workspaces/rename':
              await handleWorkspacesRename(req, res);
              return;
            case '/api/workspaces/delete':
              await handleWorkspacesDelete(req, res);
              return;
            default:
              break;
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
      writeLog('http_error', { errorCode: err?.code || err?.name || 'HTTP_ERROR' });
      sendJson(res, 500, { ok: false, error: { code: 'internal_error', message: '服务器内部错误' } });
    }  });

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
    bindPtyWebSocket(ws, sessionId, req);
  });

  server.listen(port, hostname, () => {
    writeLog('server_listen', { hostname, port });
    console.log(`> Ready on http://${hostname}:${port}`);
    // 服务先监听再扫描大型历史目录，避免首次启动长时间无法接受请求。
    setImmediate(() => {
      importEngine.syncAll()
        .then((results) => {
          writeLog('import_sync_initial', {
            sources: results.length,
            imported: results.reduce((acc, result) => acc + (result.inserted || 0), 0),
            failed: results.filter((result) => result.state === 'error').length,
          });
        })
        .catch((err) => writeLog('import_sync_initial_failed', { errorCode: err?.code || err?.name || 'IMPORT_SYNC_INITIAL_FAILED' }));
    });
  });
});

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
    // checkDirectoryExists 宸插甫 directory_not_found / path_not_directory
    handleValidationError(res, exists);
    return;
  }
  // 璁捐 3.4锛歞ata = { ok, cwd?, displayName?, error? }
  sendJson(res, 200, {
    ok: true,
    data: {
      ok: true,
      cwd: exists.resolved,
      displayName: exists.displayName,
    },
  });
}

// ===================== 对话源管理 API =====================
// 缁熶竴澶勭悊 /api/conversation-sources 鍜?/api/conversation-sources/:id/sync

async function handleConversationSources(req, res, parsedUrl) {
  const pathname = parsedUrl.pathname;

  // POST /api/conversation-sources → 添加对话源
  if (req.method === 'POST' && pathname === '/api/conversation-sources') {
    const body = await readJsonBody(req);
    if (!body?.path || typeof body.path !== 'string') {
      errorResponse(res, 400, 'invalid_path', 'path 必须是非空字符串');
      return;
    }
    if (!body?.agentType || !['claude', 'pi', 'codex', 'opencode'].includes(body.agentType)) {
      errorResponse(res, 400, 'invalid_agentType', 'agentType 必须是 claude / pi / codex / opencode');
      return;
    }
    if (handleValidationError(res, validatePath(body.path))) return;
    try {
      const r = insertConversationSource({
        path: body.path,
        agentType: body.agentType,
        label: body.label || null,
      });
      sendJson(res, 200, { ok: true, data: r });
    } catch {
      errorResponse(res, 500, 'add_failed', '添加对话源失败');
    }
    return;
  }

  // GET /api/conversation-sources → 列表对话源
  if (req.method === 'GET' && pathname === '/api/conversation-sources') {
    try {
      const items = listConversationSources();
      sendJson(res, 200, { ok: true, data: { items } });
    } catch {
      errorResponse(res, 500, 'list_failed', '读取对话源失败');
    }
    return;
  }

  // DELETE /api/conversation-sources/:id → 删除对话源
  if (req.method === 'DELETE') {
    const match = pathname.match(/^\/api\/conversation-sources\/([^/]+)$/);
    if (match) {
      const id = match[1];
      try {
        const deleted = dbDeleteConversationSource(id);
        if (!deleted) {
          errorResponse(res, 404, 'not_found', `对话源 ${id} 不存在`);
          return;
        }
        sendJson(res, 200, { ok: true, data: { ok: true } });
      } catch {
        errorResponse(res, 500, 'remove_failed', '删除对话源失败');
      }
      return;
    }
  }

  // POST /api/conversation-sources/:id/sync → 同步对话源
  if (req.method === 'POST') {
    const match = pathname.match(/^\/api\/conversation-sources\/([^/]+)\/sync$/);
    if (match) {
      const id = match[1];
      try {
        if (!importEngine) {
          errorResponse(res, 503, 'engine_not_ready', '导入引擎尚未初始化');
          return;
        }
        const result = await importEngine.syncSource(id);
        sendJson(res, 200, { ok: true, data: result });
      } catch {
        errorResponse(res, 500, 'sync_failed', '同步对话源失败');
      }
      return;
    }
  }
  // 未匹配的路由
  errorResponse(res, 404, 'not_found', `未找到路由 ${pathname}`);
}

// ===================== 琛ュ叏鏌ヨ API =====================

async function handleCompletionQuery(req, res) {
  const body = await readJsonBody(req);
  if (!body?.prefix || typeof body.prefix !== 'string') {
    errorResponse(res, 400, 'invalid_prefix', 'prefix 必须是非空字符串');
    return;
  }
  // 璁捐 C-006锛歱refix 闀垮害 1-200 瀛楃
  if (body.prefix.length > 200) {
    errorResponse(res, 400, 'prefix_too_long', 'prefix 长度不能超过 200 字符');
    return;
  }
  const limit = Math.min(Math.max(parseInt(body.limit ?? 8, 10) || 8, 1), 20);
  try {
    const items = dbQueryCompletion(body.prefix, limit);
    sendJson(res, 200, { ok: true, data: { items } });
  } catch {
    errorResponse(res, 500, 'query_failed', '查询补全失败');
  }
}

async function handleHistorySessions(req, res) {
  const body = await readJsonBody(req);
  if (handleValidationError(res, validateQuery(body?.query || '*', { required: true }))) return;
  try {
    sendJson(res, 200, { ok: true, data: listHistorySessions(body || {}) });
  } catch (err) {
    if (err instanceof HistoryServiceError) {
      errorResponse(res, err.status, err.code, err.message);
      return;
    }
    errorResponse(res, 500, 'history_sessions_failed', '读取历史会话失败');
  }
}

async function handleHistorySession(req, res) {
  const body = await readJsonBody(req);
  try {
    sendJson(res, 200, { ok: true, data: getHistorySession(body || {}) });
  } catch (err) {
    if (err instanceof HistoryServiceError) {
      errorResponse(res, err.status, err.code, err.message);
      return;
    }
    errorResponse(res, 500, 'history_session_failed', '读取历史详情失败');
  }
}

// ===================== Workspaces / Tabs API =====================

async function handleWorkspacesList(req, res) {
  try {
    sendJson(res, 200, { ok: true, data: workspaceService.listWorkspaces() });
  } catch {
    errorResponse(res, 500, 'list_workspaces_failed', '读取工作区失败');
  }
}

async function handleWorkspacesCreate(req, res) {
  try {
    const body = await readJsonBody(req);
    sendJson(res, 200, { ok: true, data: workspaceService.createWorkspace(body || {}) });
  } catch (err) {
    handleWorkspaceError(res, err, 'create_workspace_failed');
  }
}

async function handleWorkspacesRename(req, res) {
  try {
    const body = await readJsonBody(req);
    const { id, displayName } = body;
    if (!id || displayName === undefined) {
      errorResponse(res, 400, 'missing_params', '缺少 id 或 displayName 参数');
      return;
    }
    const db = getDb();
    db.prepare('UPDATE workspaces SET display_name = ? WHERE id = ?').run(displayName, id);
    sendJson(res, 200, { ok: true });
  } catch {
    errorResponse(res, 500, 'rename_workspace_failed', '重命名工作区失败');
  }
}

async function handleWorkspacesDelete(req, res) {
  try {
    const body = await readJsonBody(req);
    sendJson(res, 200, { ok: true, data: workspaceService.deleteWorkspace(body?.id, { closeActive: body?.closeActive === true }) });
  } catch (err) {
    handleWorkspaceError(res, err, 'delete_workspace_failed');
  }
}

async function handleTabsList(req, res, parsedUrl) {
  try {
    const workspaceId = decodeURIComponent(parsedUrl.pathname.split('/')[3]);
    sendJson(res, 200, { ok: true, data: workspaceService.listTabs(workspaceId) });
  } catch (err) {
    handleWorkspaceError(res, err, 'list_tabs_failed');
  }
}

async function handleTabsCreate(req, res, parsedUrl) {
  try {
    const workspaceId = decodeURIComponent(parsedUrl.pathname.split('/')[3]);
    const body = await readJsonBody(req).catch(() => ({}));
    sendJson(res, 200, { ok: true, data: workspaceService.createTab(workspaceId, body || {}) });
  } catch (err) {
    handleWorkspaceError(res, err, 'create_tab_failed');
  }
}

async function handleTabCommand(req, res, parsedUrl) {
  try {
    const tabId = decodeURIComponent(parsedUrl.pathname.split('/')[3]);
    const command = parsedUrl.pathname.split('/')[4];
    const data = command === 'close' ? workspaceService.closeActiveTab(tabId) : workspaceService.deleteTab(tabId);
    sendJson(res, 200, { ok: true, data });
  } catch (err) {
    handleWorkspaceError(res, err, 'tab_command_failed');
  }
}

function handleWorkspaceError(res, err, fallbackCode) {
  if (err instanceof WorkspaceServiceError) {
    errorResponse(res, err.status, err.code, err.message);
    return;
  }
  errorResponse(res, 500, fallbackCode, '工作区操作失败');
}

async function handleTabPreview(req, res, parsedUrl) {
  try {
    const parts = parsedUrl.pathname.split('/');
    const tabId = decodeURIComponent(parts[5]); // /api/workspaces/:cwd/tabs/:id/preview
    const preview = getPreview(tabId);
    sendJson(res, 200, { ok: true, data: { preview: preview || '' } });
  } catch {
    errorResponse(res, 500, 'preview_failed', '读取终端预览失败');
  }
}

function bindPtyWebSocket(ws, sessionId, req) {
  writeLog('ws_connected', { sessionId });
  const sessionMeta = getSession(sessionId);
  const observer = createObserver(sessionId, ws, sessionMeta);
  addObserver(sessionId, observer);
  const liveQueue = [];
  let snapshotSent = false;

  const ptyListener = (event) => {
    if (event.type === 'data') {
      // verbose 日志也只保留大小信息，不能保存终端输出正文。
      verboseLog('pty_output_chunk', { sessionId, bytes: Buffer.byteLength(event.data, 'utf-8') });
      observeOutput(observer, event.data);
      if (!snapshotSent) liveQueue.push(event);
      else sendTerminalOutput(ws, event.startOffset, event.payload);
      return;
    }
    if (event.type === 'exit') {
      observer.terminal?.flushNow('pty_exit');
      observer.terminal.dispose();
      writeLog('session_exit', { sessionId, exitCode: event.exitCode, signal: event.signal });
      sendTerminalEnvelope(ws, { type: 'session_state', state: 'ended', exitCode: event.exitCode, signal: event.signal });
      return;
    }
    if (event.type === 'closed') {
      observer.terminal?.flushNow('pty_closed');
      observer.terminal.dispose();
      sendTerminalEnvelope(ws, { type: 'session_state', state: 'closed', reason: event.reason });
      ws.close(1000, 'session closed');
    }
  };

  addSessionListener(sessionId, ptyListener);
  const requestedOffset = parseLastOffset(req);
  const snapshot = getOutputSnapshot(sessionId, requestedOffset);
  if (!snapshot.ok) {
    sendTerminalEnvelope(ws, { type: 'error', code: snapshot.error.code, message: snapshot.error.message, oldestOffset: String(snapshot.oldestOffset ?? 0n), currentOffset: String(snapshot.currentOffset ?? 0n) });
    removeSessionListener(sessionId, ptyListener);
    removeObserver(sessionId, observer);
    ws.close(1011, snapshot.error.code);
    return;
  }
  sendTerminalEnvelope(ws, {
    type: 'hello',
    session: sessionMeta,
    snapshotStartOffset: String(snapshot.oldestOffset),
    currentOffset: String(snapshot.currentOffset),
  });
  for (const frame of snapshot.frames) sendTerminalOutput(ws, frame.startOffset, frame.payload);
  snapshotSent = true;
  for (const event of liveQueue.splice(0)) {
    const endOffset = event.startOffset + BigInt(event.byteLength);
    if (endOffset <= snapshot.currentOffset) continue;
    if (event.startOffset < snapshot.currentOffset) {
      const sliceStart = Number(snapshot.currentOffset - event.startOffset);
      sendTerminalOutput(ws, snapshot.currentOffset, event.payload.subarray(sliceStart));
      continue;
    }
    sendTerminalOutput(ws, event.startOffset, event.payload);
  }

  ws.on('message', async (message, isBinary) => {
    try {
      const input = messageToTerminalInput(message);
      // 终端输入可能包含命令和密钥，日志只记录传输元数据。
      verboseLog('ws_message', { sessionId, isBinary, bytes: input.bytes });

      touchSession(sessionId);

      if (!isBinary && maybeHandleControlMessage(ws, sessionId, input.text, observer)) {
        return;
      }

      observeInput(observer, input.text);
      writeRawInput(ws, sessionId, input.text, input.bytes);
    } catch (err) {
      writeLog('ws_message_error', { sessionId, errorCode: err?.code || err?.name || 'WS_MESSAGE_ERROR' });
    }
  });

  ws.on('close', () => {
    observer.terminal?.flushNow('ws_closed');
    observer.terminal.dispose();
    writeLog('ws_closed', { sessionId });
    removeSessionListener(sessionId, ptyListener);
    removeObserver(sessionId, observer);
  });

  ws.on('error', (err) => {
    writeLog('ws_error', { sessionId, errorCode: err?.code || err?.name || 'WS_ERROR' });
  });
}

function messageToTerminalInput(message) {
  if (Buffer.isBuffer(message)) {
    return { text: message.toString('utf-8'), bytes: message.length };
  }
  const text = String(message);
  return { text, bytes: Buffer.byteLength(text, 'utf-8') };
}

function maybeHandleControlMessage(ws, sessionId, text, observer) {
  let envelope = null;
  try { envelope = JSON.parse(text); }
  catch { return false; }
  if (!envelope || typeof envelope !== 'object') return false;
  if (envelope.v === 1) {
    try { envelope = parseControlEnvelope(text); }
    catch (err) {
      sendTerminalEnvelope(ws, { type: 'error', code: err.code || 'BAD_CONTROL_FRAME', message: err.message });
      ws.close(1002, err.code || 'BAD_CONTROL_FRAME');
      return true;
    }
    if (envelope.type === 'resize') {
      const ok = resize(sessionId, envelope.cols, envelope.rows);
      if (ok) {
        try { observer?.terminal?.resize(envelope.cols, envelope.rows); }
        catch (err) { writeLog('grid_resize_failed', { sessionId, cols: envelope.cols, rows: envelope.rows, errorCode: err?.code || err?.name || 'GRID_RESIZE_FAILED' }); }
      }
      verboseLog('resize', { sessionId, cols: envelope.cols, rows: envelope.rows, ok });
      if (!ok) writeLog('resize_failed', { sessionId, cols: envelope.cols, rows: envelope.rows });
      return true;
    }
    return false;
  }
  const ctrl = envelope._ctrl;
  if (!ctrl || typeof ctrl !== 'object') return false;
  if (ctrl.type === 'resize') {
    const ok = resize(sessionId, ctrl.cols, ctrl.rows);
    // P1a：同步 headless grid 尺寸，否则 pi 按真实宽度算的 cursor-up 行数与 grid 错位 → snapshot 乱行。
    if (ok) {
      try { observer?.terminal?.resize(ctrl.cols, ctrl.rows); }
      catch (err) { writeLog('grid_resize_failed', { sessionId, cols: ctrl.cols, rows: ctrl.rows, errorCode: err?.code || err?.name || 'GRID_RESIZE_FAILED' }); }
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
    writeLog('pty_write_failed', { sessionId, bytes });
  }
}









