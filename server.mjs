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
  dispose as disposePtySession,
  getSession,
  killSession,
  removeSessionListener,
  resize,
  writeToSession,
} from './server/pty-manager.mjs';
import { startSweeper, touchSession, getPreview } from './server/pty-manager.mjs';

import {
  validateCwd,
  validatePath,
  validateQuery,
  checkDirectoryExists,
  readBoundedRequestBody,
} from './server/validation.mjs';

import { initializeDatabase, getDb } from './server/database.mjs';
import {
  insertConversationSource,
  listConversationSources,
  deleteConversationSource as dbDeleteConversationSource,
  queryCompletion as dbQueryCompletion,
  listConversations,
} from './server/database.mjs';
import { createImportEngine } from './server/conversation-import.mjs';
import { getActiveSessions } from './server/pty-manager.mjs';
import { discoverDefaultSources } from './server/startup-discovery.mjs';

// 导入引擎实例（启动流程中初始化，sync API 复用）
let importEngine = null;
/** @returns {ReturnType<typeof createImportEngine> | null} */
export function getImportEngine() {
  return importEngine;
}

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
        writeLog('user_message', { sessionId: observer.sessionId, text, bytes: Buffer.byteLength(text, 'utf-8') });
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

app.prepare().then(() => {
  // 初始化 SQLite 数据库；支持 DATA_DIR 环境变量覆盖（测试用）
  const dbPath = process.env.DATA_DIR
    ? join(process.env.DATA_DIR, 'nterminal.db')
    : join(process.cwd(), 'data', 'nterminal.db');
  initializeDatabase(dbPath);

  // 首次启动自动发现默认对话源
  discoverDefaultSources(getDb());

  // 创建导入引擎：定时同步（1h）+ fs.watch 文件变更触发
  // 设计 C-001/C-013：startup → initializeDatabase → syncAll → startScheduler → startWatcher
  importEngine = createImportEngine({ db: getDb() });
  importEngine
    .syncAll()
    .then((results) => {
      writeLog('import_sync_initial', {
        sources: results.length,
        imported: results.reduce((acc, r) => acc + r.result.importedCount, 0),
        failed: results.reduce((acc, r) => acc + r.result.failedCount, 0),
      });
    })
    .catch((err) => writeLog('import_sync_initial_failed', { message: err instanceof Error ? err.message : String(err) }));
  importEngine.startScheduler();
  importEngine.startWatcher();

  // 启动 PTY 清理定时器（30s 扫一次，60s 无连接 kill）
  startSweeper();

  writeLog('server_ready', { dev, hostname, port, cwd: process.cwd(), verboseLog: VERBOSE_LOG, dbPath });

  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url || '/', true);
      verboseLog('http_request', { method: req.method, pathname: parsedUrl.pathname });

      if (parsedUrl.pathname.startsWith('/api/')) {
        // conversation-sources 允许 GET/POST/DELETE
        if (parsedUrl.pathname.startsWith('/api/conversation-sources')) {
          await handleConversationSources(req, res, parsedUrl);
          return;
        }
        // session/list 允许 GET 和 POST
        if (parsedUrl.pathname === '/api/session/list') {
          await handleSessionsList(req, res);
          return;
        }
        // session/:id/kill 必须 POST，提前拦截避免掉到 405 分支
        if (/^\/api\/session\/[^/]+\/kill$/.test(parsedUrl.pathname)) {
          if (req.method !== 'POST') {
            errorResponse(res, 405, 'method_not_allowed', '只允许 POST 方法');
            return;
          }
          await handleSessionKill(req, res, parsedUrl);
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
        if (/^\/api\/tabs\/[^/]+\/kill$/.test(parsedUrl.pathname)) {
          if (req.method !== 'POST') { errorResponse(res, 405, 'method_not_allowed', '只允许 POST'); return; }
          await handleTabKill(req, res, parsedUrl);
          return;
        }
        if (/^\/api\/workspaces\/[^/]+\/tabs\/[^/]+\/preview$/.test(parsedUrl.pathname)) {
          await handleTabPreview(req, res, parsedUrl);
          return;
        }
        // 其余 API 只允许 POST
        if (req.method !== 'POST') {
          errorResponse(res, 405, 'method_not_allowed', '只允许 POST 方法');
          return;
        }
        switch (parsedUrl.pathname) {
            case '/api/session/create':
              await handleCreateSession(req, res);
              return;
            case '/api/directory/validate':
              await handleDirectoryValidate(req, res);
              return;
            case '/api/completion/query':
              await handleCompletionQuery(req, res);
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
  // tagLabel 可选字符串，长度上限 200 避免脏数据
  const tagLabel = typeof body?.tagLabel === 'string' && body.tagLabel.trim() ? body.tagLabel.trim().slice(0, 200) : null;
  // 标签数量限制：最多 8 个活跃会话（统计要在 create 之前，避免超额时仍然分配了 PTY）
  if (getActiveSessions().length >= 8) {
    errorResponse(res, 400, 'session_limit_reached', '最多 8 个活跃标签');
    return;
  }
  const result = createSession({ cwd: cwd || process.cwd(), tagLabel });
  writeLog('session_created', {
    id: result.id, status: result.status, command: result.command, cwd: result.cwd,
    error: result.error || null, tagLabel: result.tagLabel || null,
  });
  if (result.status === 'error') {
    // 失败响应壳统一为 {ok:false, error:{code,message}}，不再附带 data.session
    errorResponse(res, 500, 'spawn_failed', result.error || '创建 PTY 会话失败');
    return;
  }
  // 创建成功后再取一次 activeSessions，确保响应里包含新建的那一个
  const activeSessions = getActiveSessions();
  sendJson(res, 200, { ok: true, data: { session: result, activeSessions } });
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

// ===================== 对话源管理 API =====================
// 统一处理 /api/conversation-sources 和 /api/conversation-sources/:id/sync

async function handleConversationSources(req, res, parsedUrl) {
  const pathname = parsedUrl.pathname;

  // POST /api/conversation-sources → 添加对话源
  if (req.method === 'POST' && pathname === '/api/conversation-sources') {
    const body = await readJsonBody(req);
    if (!body?.path || typeof body.path !== 'string') {
      errorResponse(res, 400, 'invalid_path', 'path 必须是非空字符串');
      return;
    }
    if (!body?.agentType || !['claude', 'pi', 'codex'].includes(body.agentType)) {
      errorResponse(res, 400, 'invalid_agentType', 'agentType 必须是 claude / pi / codex');
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
    } catch (err) {
      errorResponse(res, 500, 'add_failed', err instanceof Error ? err.message : String(err));
    }
    return;
  }

  // GET /api/conversation-sources → 列表对话源
  if (req.method === 'GET' && pathname === '/api/conversation-sources') {
    try {
      const items = listConversationSources();
      sendJson(res, 200, { ok: true, data: { items } });
    } catch (err) {
      errorResponse(res, 500, 'list_failed', err instanceof Error ? err.message : String(err));
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
      } catch (err) {
        errorResponse(res, 500, 'remove_failed', err instanceof Error ? err.message : String(err));
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
        // 设计 C-001：调用引擎执行真实解析，返回真实计数
        const result = importEngine.syncSource
          ? await importEngine.syncSource(id)
          : await importEngine.syncAll().then((rs) => {
              const found = rs.find((r) => r.sourceId === id);
              return found ? found.result : { importedCount: 0, skippedCount: 0, failedCount: 1 };
            });
        sendJson(res, 200, { ok: true, data: result });
      } catch (err) {
        errorResponse(res, 500, 'sync_failed', err instanceof Error ? err.message : String(err));
      }
      return;
    }
  }

  // 未匹配的路由
  errorResponse(res, 404, 'not_found', `未找到路由 ${pathname}`);
}

// ===================== 补全查询 API =====================

async function handleCompletionQuery(req, res) {
  const body = await readJsonBody(req);
  if (!body?.prefix || typeof body.prefix !== 'string') {
    errorResponse(res, 400, 'invalid_prefix', 'prefix 必须是非空字符串');
    return;
  }
  // 设计 C-006：prefix 长度 1-200 字符
  if (body.prefix.length > 200) {
    errorResponse(res, 400, 'prefix_too_long', 'prefix 长度不能超过 200 字符');
    return;
  }
  const limit = Math.min(Math.max(parseInt(body.limit ?? 8, 10) || 8, 1), 20);
  try {
    const items = dbQueryCompletion(body.prefix, limit);
    sendJson(res, 200, { ok: true, data: { items } });
  } catch (err) {
    errorResponse(res, 500, 'query_failed', err instanceof Error ? err.message : String(err));
  }
}

// ===================== 会话列表 API =====================

async function handleSessionsList(req, res) {
  try {
    const sessions = getActiveSessions();
    sendJson(res, 200, { ok: true, data: { sessions } });
  } catch (err) {
    errorResponse(res, 500, 'list_failed', err instanceof Error ? err.message : String(err));
  }
}

// 关闭会话：kill PTY + 从 Map 移除（幂等）
async function handleSessionKill(req, res, parsedUrl) {
  try {
    // 路径形如 /api/session/:id/kill，提取 id
    const m = parsedUrl.pathname.match(/^\/api\/session\/([^/]+)\/kill$/);
    const sessionId = m ? m[1] : '';
    if (!sessionId || sessionId === 'undefined') {
      errorResponse(res, 400, 'invalid_sessionId', 'sessionId 不能为空');
      return;
    }
    // 关闭前先踢掉挂在该 session 上的 WS（避免 zombie observer）
    const observer = sessionObservers.get(sessionId);
    if (observer) {
      try { observer.ws.close(1000, 'session_killed'); } catch { /* ignore */ }
      sessionObservers.delete(sessionId);
    }
    const ok = killSession(sessionId);
    if (!ok) {
      // 不存在也算成功（幂等），但记录日志
      writeLog('session_kill_noop', { sessionId });
    } else {
      writeLog('session_killed', { sessionId });
    }
    sendJson(res, 200, { ok: true, data: { killed: ok } });
  } catch (err) {
    errorResponse(res, 500, 'kill_failed', err instanceof Error ? err.message : String(err));
  }
}

// ===================== Workspaces / Tabs API =====================

async function handleWorkspacesList(req, res) {
  try {
    const db = getDb();
    const workspaces = db.prepare('SELECT * FROM workspaces ORDER BY last_active_at DESC').all();
    sendJson(res, 200, { ok: true, data: workspaces });
  } catch (err) {
    errorResponse(res, 500, 'list_workspaces_failed', err instanceof Error ? err.message : String(err));
  }
}

async function handleWorkspacesCreate(req, res) {
  try {
    const body = await readBoundedRequestBody(req);
    const { cwd, displayName } = body;
    if (!cwd) {
      errorResponse(res, 400, 'missing_cwd', '缺少 cwd 参数');
      return;
    }
    const exists = checkDirectoryExists(cwd);
    if (!exists.ok) {
      errorResponse(res, 400, 'invalid_cwd', exists.message);
      return;
    }
    const db = getDb();
    const existing = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(cwd);
    if (existing) {
      sendJson(res, 200, { ok: true, data: { id: cwd, created: false } });
      return;
    }
    db.prepare('INSERT INTO workspaces (id, display_name) VALUES (?, ?)').run(cwd, displayName || null);
    sendJson(res, 200, { ok: true, data: { id: cwd, created: true } });
  } catch (err) {
    errorResponse(res, 500, 'create_workspace_failed', err instanceof Error ? err.message : String(err));
  }
}

async function handleWorkspacesRename(req, res) {
  try {
    const body = await readBoundedRequestBody(req);
    const { id, displayName } = body;
    if (!id || displayName === undefined) {
      errorResponse(res, 400, 'missing_params', '缺少 id 或 displayName 参数');
      return;
    }
    const db = getDb();
    db.prepare('UPDATE workspaces SET display_name = ? WHERE id = ?').run(displayName, id);
    sendJson(res, 200, { ok: true });
  } catch (err) {
    errorResponse(res, 500, 'rename_workspace_failed', err instanceof Error ? err.message : String(err));
  }
}

async function handleWorkspacesDelete(req, res) {
  try {
    const body = await readBoundedRequestBody(req);
    const { id } = body;
    if (!id) {
      errorResponse(res, 400, 'missing_id', '缺少 id 参数');
      return;
    }
    const db = getDb();
    const runningTabs = db.prepare(
      "SELECT COUNT(*) as cnt FROM tab_sessions WHERE workspace_id = ? AND pty_status = 'running'"
    ).get(id);
    if (runningTabs.cnt > 0) {
      errorResponse(res, 409, 'has_running_tabs', '工作区仍有运行中的标签页');
      return;
    }
    db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
    sendJson(res, 200, { ok: true });
  } catch (err) {
    errorResponse(res, 500, 'delete_workspace_failed', err instanceof Error ? err.message : String(err));
  }
}

async function handleTabsList(req, res, parsedUrl) {
  try {
    const cwd = decodeURIComponent(parsedUrl.pathname.split('/')[3]);
    const db = getDb();
    const tabs = db.prepare('SELECT * FROM tab_sessions WHERE workspace_id = ? ORDER BY created_at DESC').all(cwd);
    sendJson(res, 200, { ok: true, data: tabs });
  } catch (err) {
    errorResponse(res, 500, 'list_tabs_failed', err instanceof Error ? err.message : String(err));
  }
}

async function handleTabsCreate(req, res, parsedUrl) {
  try {
    const cwd = decodeURIComponent(parsedUrl.pathname.split('/')[3]);
    const body = await readBoundedRequestBody(req).catch(() => ({}));
    const result = createSession({ cwd, ...body });
    if (!result.ok) {
      errorResponse(res, 400, 'pty_create_failed', result.error || '创建终端失败');
      return;
    }
    const db = getDb();
    const tabId = result.id;
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO tab_sessions (id, workspace_id, pty_status, created_at, last_ws_seen_at) VALUES (?, ?, 'running', ?, ?)"
    ).run(tabId, cwd, now, now);
    db.prepare(
      "UPDATE workspaces SET session_count = session_count + 1, last_active_at = ? WHERE id = ?"
    ).run(now, cwd);
    sendJson(res, 200, { ok: true, data: { id: tabId, cwd } });
  } catch (err) {
    errorResponse(res, 500, 'create_tab_failed', err instanceof Error ? err.message : String(err));
  }
}

async function handleTabKill(req, res, parsedUrl) {
  try {
    const tabId = decodeURIComponent(parsedUrl.pathname.split('/')[3]);
    const db = getDb();
    const tab = db.prepare('SELECT * FROM tab_sessions WHERE id = ?').get(tabId);
    if (!tab) {
      errorResponse(res, 404, 'tab_not_found', '标签页不存在');
      return;
    }
    killSession(tabId);
    const now = new Date().toISOString();
    db.prepare(
      "UPDATE tab_sessions SET pty_status = 'ended', killed_at = ? WHERE id = ?"
    ).run(now, tabId);
    db.prepare(
      "UPDATE workspaces SET session_count = MAX(0, session_count - 1) WHERE id = ?"
    ).run(tab.workspace_id);
    sendJson(res, 200, { ok: true, data: { killed: true } });
  } catch (err) {
    errorResponse(res, 500, 'kill_tab_failed', err instanceof Error ? err.message : String(err));
  }
}

async function handleTabPreview(req, res, parsedUrl) {
  try {
    const parts = parsedUrl.pathname.split('/');
    const tabId = decodeURIComponent(parts[5]); // /api/workspaces/:cwd/tabs/:id/preview
    const preview = getPreview(tabId);
    sendJson(res, 200, { ok: true, data: { preview: preview || '' } });
  } catch (err) {
    errorResponse(res, 500, 'preview_failed', err instanceof Error ? err.message : String(err));
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
      observer.terminal?.flushNow('pty_exit');
      observer.terminal.dispose();
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

      touchSession(sessionId);

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
    observer.terminal.dispose();
    // 主动 kill PTY 进程并从 sessions Map 删除，避免关页后子进程泄漏
    try { disposePtySession(sessionId); }
    catch (err) { writeLog('pty_dispose_failed', { sessionId, message: err instanceof Error ? err.message : String(err) }); }
    writeLog('ws_closed', { sessionId });
    removeSessionListener(sessionId, ptyListener);
    sessionObservers.delete(sessionId);
  });

  ws.on('error', (err) => {
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


