/**
 * 工作区与标签服务。
 * 通过 createPty/closePty 注入 PTY 管理依赖，把 PTY 进程生命周期与 SQLite 标签表绑定，
 * 保证数据库写入失败时回滚 PTY 运行态，避免出现无主 PTY 进程。
 */

import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

// WorkspaceServiceError：服务层错误，包含 HTTP 状态码与 details 便于上层转译。
export class WorkspaceServiceError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message);
    this.name = 'WorkspaceServiceError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

// requireRequestId：保证幂等创建时携带稳定 requestId，避免前端重试导致重复标签。
function requireRequestId(requestId) {
  if (typeof requestId !== 'string' || !requestId.trim()) {
    throw new WorkspaceServiceError('INVALID_REQUEST_ID', 'requestId 必须是非空字符串');
  }
  return requestId.trim();
}

// normalizeCwd：把 cwd 解析为绝对路径并验证为目录，作为 workspace 主键避免同名目录冲突。
function normalizeCwd(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim()) {
    throw new WorkspaceServiceError('INVALID_CWD', 'cwd 必须是非空字符串');
  }
  try {
    const normalized = realpathSync(resolve(cwd.trim()));
    if (!statSync(normalized).isDirectory()) throw new Error('not-directory');
    return normalized;
  } catch {
    throw new WorkspaceServiceError('INVALID_CWD', '工作区目录不存在或不可访问');
  }
}

// serializeWorkspace：把 workspaces 行按 camelCase 字段重命名后返回，DB 与 API 解耦。
function serializeWorkspace(row) {
  return {
    id: row.id,
    displayName: row.display_name,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    sessionCount: row.session_count,
  };
}

// serializeTab：标签行转 API 形态，额外回传所属 workspaceId 便于前端路由。
function serializeTab(row, cwd) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    cwd,
    label: row.label,
    status: row.pty_status,
    createRequestId: row.create_request_id,
    createdAt: row.created_at,
    endedAt: row.ended_at,
    exitCode: row.exit_code,
    exitSignal: row.exit_signal,
  };
}

/**
 * 构造工作区与标签服务；注入 db 与 PTY 操作以避免直接耦合到 pty-manager。
 * @param {{db: import('better-sqlite3').Database, createPty: Function, closePty: Function}} deps
 */
export function createWorkspaceService({ db, createPty, closePty }) {
  if (!db || typeof createPty !== 'function' || typeof closePty !== 'function') {
    throw new Error('workspace service 需要 db/createPty/closePty');
  }

  function getWorkspace(workspaceId) {
    const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);
    if (!row) throw new WorkspaceServiceError('WORKSPACE_NOT_FOUND', '工作区不存在', 404);
    return row;
  }

  function createWorkspace({ cwd, displayName = null, requestId }) {
    requireRequestId(requestId);
    const id = normalizeCwd(cwd);
    const existing = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
    if (existing) return { workspace: serializeWorkspace(existing), deduplicated: true };
    db.prepare('INSERT INTO workspaces (id, display_name, last_active_at) VALUES (?, ?, ?)')
      .run(id, displayName?.trim() || null, new Date().toISOString());
    return { workspace: serializeWorkspace(getWorkspace(id)), deduplicated: false };
  }

  function createTab(workspaceId, { requestId, label = null }) {
    const normalizedRequestId = requireRequestId(requestId);
    const duplicate = db.prepare('SELECT * FROM tab_sessions WHERE create_request_id = ?').get(normalizedRequestId);
    if (duplicate) {
      const duplicateWorkspace = getWorkspace(duplicate.workspace_id);
      return { tab: serializeTab(duplicate, duplicateWorkspace.id), deduplicated: true };
    }
    const workspace = getWorkspace(workspaceId);
    const pty = createPty({ cwd: workspace.id, tagLabel: label?.trim() || null });
    if (!pty?.id || pty.status === 'error') {
      throw new WorkspaceServiceError('PTY_CREATE_FAILED', pty?.error || '创建终端失败', 500);
    }
    const now = new Date().toISOString();
    try {
      db.transaction(() => {
        db.prepare(`
          INSERT INTO tab_sessions
            (id, workspace_id, pty_status, created_at, last_ws_seen_at, label, create_request_id)
          VALUES (?, ?, 'running', ?, ?, ?, ?)
        `).run(pty.id, workspace.id, now, now, label?.trim() || null, normalizedRequestId);
        db.prepare(`
          UPDATE workspaces SET last_active_at = ?,
            session_count = (SELECT COUNT(*) FROM tab_sessions WHERE workspace_id = ? AND pty_status = 'running')
          WHERE id = ?
        `).run(now, workspace.id, workspace.id);
      })();
    } catch (error) {
      // 数据库写入失败时立即回收已创建 PTY，防止运行态成为无主进程。
      closePty(pty.id);
      throw error;
    }
    const row = db.prepare('SELECT * FROM tab_sessions WHERE id = ?').get(pty.id);
    return { tab: serializeTab(row, workspace.id), deduplicated: false };
  }

  function closeActiveTab(tabId) {
    const tab = db.prepare('SELECT * FROM tab_sessions WHERE id = ?').get(tabId);
    if (!tab) return { closed: false, deduplicated: true };
    if (tab.pty_status !== 'running') return { closed: false, deduplicated: true };
    closePty(tabId);
    const now = new Date().toISOString();
    db.transaction(() => {
      db.prepare("UPDATE tab_sessions SET pty_status = 'ended', ended_at = ? WHERE id = ?").run(now, tabId);
      db.prepare(`UPDATE workspaces SET
        session_count = (SELECT COUNT(*) FROM tab_sessions WHERE workspace_id = ? AND pty_status = 'running')
        WHERE id = ?`).run(tab.workspace_id, tab.workspace_id);
    })();
    return { closed: true, deduplicated: false };
  }

  function deleteTab(tabId) {
    const tab = db.prepare('SELECT * FROM tab_sessions WHERE id = ?').get(tabId);
    if (!tab) return { deleted: false };
    if (tab.pty_status === 'running') {
      throw new WorkspaceServiceError('ACTIVE_TAB_REQUIRES_CLOSE', '活动标签必须先显式关闭', 409, { tabId });
    }
    db.prepare('DELETE FROM tab_sessions WHERE id = ?').run(tabId);
    return { deleted: true };
  }

  function deleteWorkspace(workspaceId, { closeActive = false } = {}) {
    const workspace = getWorkspace(workspaceId);
    const activeTabs = db.prepare("SELECT id FROM tab_sessions WHERE workspace_id = ? AND pty_status = 'running'").all(workspace.id);
    if (activeTabs.length > 0 && !closeActive) {
      throw new WorkspaceServiceError('ACTIVE_TABS_REQUIRE_CLOSE', '工作区仍有活动标签', 409, { activeCount: activeTabs.length });
    }
    for (const tab of activeTabs) closeActiveTab(tab.id);
    db.transaction(() => {
      db.prepare('DELETE FROM tab_sessions WHERE workspace_id = ?').run(workspace.id);
      db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspace.id);
    })();
    return { deleted: true, closedTabs: activeTabs.length };
  }

  function listWorkspaces() {
    return db.prepare('SELECT * FROM workspaces ORDER BY last_active_at DESC, created_at DESC').all().map(serializeWorkspace);
  }

  function listTabs(workspaceId) {
    const workspace = getWorkspace(workspaceId);
    return db.prepare('SELECT * FROM tab_sessions WHERE workspace_id = ? ORDER BY created_at').all(workspace.id)
      .map((row) => serializeTab(row, workspace.id));
  }

  return { createWorkspace, createTab, closeActiveTab, deleteTab, deleteWorkspace, listWorkspaces, listTabs };
}
