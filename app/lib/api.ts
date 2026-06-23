/**
 * 前端 HTTP API 客户端
 * 全部 POST，body 走 JSON；统一响应壳 {ok:true, data} | {ok:false, error:{code,message}}
 */

import type {
  ValidateResponse,
  ConversationSource,
  CompletionQueryResponse,
  Workspace,
  HistorySessionDetailResponse,
  HistorySessionsResponse,
} from './types';

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

export async function postJson<T>(path: string, body: unknown, options: { signal?: AbortSignal } = {}): Promise<T> {
  const doFetch = (): Promise<Response> =>
    fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: options.signal,
    });

  let res: Response;
  try {
    res = await doFetch();
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw err; // 让上层识别取消
    }
    throw new ApiError(err instanceof Error ? err.message : '网络错误', 'network_error', 0);
  }

  let parsed: { ok?: boolean; data?: T; error?: { code: string; message: string } } | null = null;
  try {
    parsed = await res.json();
  } catch {
    // dev 模式下 Turbopack 编译期间偶发返回 200 HTML 页（非 JSON）。
    // 对 200 的非法 JSON 延迟重试一次，吸收编译竞态；非 200 维持原行为。
    if (res.status === 200 && !options.signal?.aborted) {
      await new Promise((r) => setTimeout(r, 400));
      if (options.signal?.aborted) {
        throw new ApiError('aborted', 'aborted', 0);
      }
      try {
        res = await doFetch();
        parsed = await res.json();
      } catch {
        throw new ApiError(`响应不是合法 JSON (status ${res.status})`, 'invalid_response', res.status);
      }
    } else {
      throw new ApiError(`响应不是合法 JSON (status ${res.status})`, 'invalid_response', res.status);
    }
  }

  if (!parsed || !parsed.ok) {
    const code = parsed?.error?.code || 'unknown_error';
    const message = parsed?.error?.message || `请求失败 (status ${res.status})`;
    throw new ApiError(message, code, res.status);
  }

  return parsed.data as T;
}

async function getJson<T>(path: string, options: { signal?: AbortSignal } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { method: 'GET', signal: options.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    throw new ApiError(err instanceof Error ? err.message : '网络错误', 'network_error', 0);
  }

  let parsed: { ok?: boolean; data?: T; error?: { code: string; message: string } };
  try {
    parsed = await res.json();
  } catch {
    throw new ApiError(`响应不是合法 JSON (status ${res.status})`, 'invalid_response', res.status);
  }
  if (!parsed.ok) {
    throw new ApiError(
      parsed.error?.message || `请求失败 (status ${res.status})`,
      parsed.error?.code || 'unknown_error',
      res.status,
    );
  }
  return parsed.data as T;
}

export function validateDirectory(body: { path: string }, options?: { signal?: AbortSignal }): Promise<ValidateResponse> {
  return postJson<ValidateResponse>('/api/directory/validate', body, options);
}

// ---- Workspaces ----

export function listWorkspaces(options?: { signal?: AbortSignal }): Promise<Workspace[]> {
  return postJson<Workspace[]>('/api/workspaces/list', {}, options);
}

export function createWorkspace(body: { cwd: string; displayName?: string; requestId: string }, options?: { signal?: AbortSignal }): Promise<{ workspace: Workspace; deduplicated: boolean }> {
  return postJson('/api/workspaces/create', body, options);
}

export function deleteWorkspace(body: { id: string; closeActive?: boolean }, options?: { signal?: AbortSignal }): Promise<{ deleted: boolean; closedTabs: number }> {
  return postJson('/api/workspaces/delete', body, options);
}

export function listTabs(workspaceId: string, options?: { signal?: AbortSignal }): Promise<import('./types').TabInfo[]> {
  return postJson(`/api/workspaces/${encodeURIComponent(workspaceId)}/tabs/list`, {}, options);
}

export function createTab(workspaceId: string, body: { requestId: string; label?: string }, options?: { signal?: AbortSignal }) {
  return postJson<{ tab: import('./types').TabInfo; deduplicated: boolean }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/tabs/create`, body, options);
}

export function closeTab(id: string, options?: { signal?: AbortSignal }) {
  return postJson<{ closed: boolean }>(`/api/tabs/${encodeURIComponent(id)}/close`, {}, options);
}

export function deleteTab(id: string, options?: { signal?: AbortSignal }) {
  return postJson<{ deleted: boolean }>(`/api/tabs/${encodeURIComponent(id)}/delete`, {}, options);
}

export function previewTab(workspaceCwd: string, tabId: string, options?: { signal?: AbortSignal }): Promise<{ preview: string }> {
  return postJson<{ preview: string }>(`/api/workspaces/${encodeURIComponent(workspaceCwd)}/tabs/${encodeURIComponent(tabId)}/preview`, {}, options);
}

// ---- 对话源管理 ----

export function addConversationSource(body: { path: string; agentType: string; label?: string }, options?: { signal?: AbortSignal }): Promise<ConversationSource> {
  return postJson<ConversationSource>('/api/conversation-sources', body, options);
}

export function listConversationSources(options?: { signal?: AbortSignal }): Promise<{ items: ConversationSource[] }> {
  // POST 表示新增来源；列表必须使用 GET，避免空 body 被当作新增请求。
  return getJson<{ items: ConversationSource[] }>('/api/conversation-sources', options);
}

// 统一封装走 fetch + 响应壳校验，AbortError 透传与其他方法一致
export async function removeConversationSource(id: string, options?: { signal?: AbortSignal }): Promise<{ ok: true }> {
  let res: Response;
  try {
    res = await fetch('/api/conversation-sources/' + id, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      signal: options?.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    throw new ApiError(err instanceof Error ? err.message : '网络错误', 'network_error', 0);
  }
  let parsed: { ok?: boolean; data?: { ok: true }; error?: { code: string; message: string } } | null = null;
  try {
    parsed = await res.json();
  } catch {
    throw new ApiError(`响应不是合法 JSON (status ${res.status})`, 'invalid_response', res.status);
  }
  if (!parsed || !parsed.ok) {
    const code = parsed?.error?.code || 'unknown_error';
    const message = parsed?.error?.message || `请求失败 (status ${res.status})`;
    throw new ApiError(message, code, res.status);
  }
  return parsed.data as { ok: true };
}

// sync 返回的 data 直接是 { importedCount, skippedCount, failedCount }，postJson 已解包 ok 外壳
export interface SyncResult {
  sourceId: string;
  state: 'active' | 'error';
  inserted: number;
  updated: number;
  deleted: number;
  skipped?: boolean;
}

export function syncConversationSource(id: string, options?: { signal?: AbortSignal }): Promise<SyncResult> {
  return postJson<SyncResult>('/api/conversation-sources/' + id + '/sync', {}, options);
}

// ---- 补全查询 ----

export function queryCompletion(body: { prefix: string; limit?: number }, options?: { signal?: AbortSignal }): Promise<CompletionQueryResponse> {
  return postJson<CompletionQueryResponse>('/api/completion/query', body, options);
}

export function listHistorySessions(body: { query?: string; limit?: number }, options?: { signal?: AbortSignal }): Promise<HistorySessionsResponse> {
  return postJson<HistorySessionsResponse>('/api/history/sessions', body, options);
}

export function getHistorySession(body: { sourceId: string; sessionKey: string }, options?: { signal?: AbortSignal }): Promise<HistorySessionDetailResponse> {
  return postJson<HistorySessionDetailResponse>('/api/history/session', body, options);
}

export const api = {
  validateDirectory,
  listWorkspaces,
  createWorkspace,
  deleteWorkspace,
  listTabs,
  createTab,
  closeTab,
  deleteTab,
  previewTab,
  addConversationSource,
  listConversationSources,
  removeConversationSource,
  syncConversationSource,
  queryCompletion,
  listHistorySessions,
  getHistorySession,
};

export default api;
