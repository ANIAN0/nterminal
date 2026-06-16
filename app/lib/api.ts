/**
 * 前端 HTTP API 客户端
 * 全部 POST，body 走 JSON；统一响应壳 {ok:true, data} | {ok:false, error:{code,message}}
 */

import type {
  SessionInfo,
  ValidateResponse,
  PathHistoryListResponse,
  PathHistorySaveResponse,
  PathHistoryItem,
  RecordsListResponse,
  RecordsSearchResponse,
  RecordDetailResponse,
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
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: options.signal,
    });
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
    throw new ApiError(`响应不是合法 JSON (status ${res.status})`, 'invalid_response', res.status);
  }

  if (!parsed || !parsed.ok) {
    const code = parsed?.error?.code || 'unknown_error';
    const message = parsed?.error?.message || `请求失败 (status ${res.status})`;
    throw new ApiError(message, code, res.status);
  }

  return parsed.data as T;
}

// 9 个 API 方法
export function createSession(body: { cwd: string; cols?: number; rows?: number }, options?: { signal?: AbortSignal }): Promise<SessionInfo> {
  return postJson<SessionInfo>('/api/session/create', body, options);
}

export function validateDirectory(body: { path: string }, options?: { signal?: AbortSignal }): Promise<ValidateResponse> {
  return postJson<ValidateResponse>('/api/directory/validate', body, options);
}

export function listPathHistory(body: { limit?: number } = {}, options?: { signal?: AbortSignal }): Promise<PathHistoryListResponse> {
  return postJson<PathHistoryListResponse>('/api/path-history/list', body, options);
}

export function savePathHistory(body: { path: string }, options?: { signal?: AbortSignal }): Promise<PathHistorySaveResponse> {
  return postJson<PathHistorySaveResponse>('/api/path-history/save', body, options);
}

export function deletePathHistory(body: { path: string }, options?: { signal?: AbortSignal }): Promise<{ ok: true }> {
  return postJson<{ ok: true }>('/api/path-history/delete', body, options);
}

export function clearPathHistory(options?: { signal?: AbortSignal }): Promise<{ ok: true }> {
  return postJson<{ ok: true }>('/api/path-history/clear', {}, options);
}

export function listRecords(body: {
  query?: string;
  cwd?: string | null;
  sessionId?: string | null;
  limit?: number;
  offset?: number;
} = {}, options?: { signal?: AbortSignal }): Promise<RecordsListResponse> {
  return postJson<RecordsListResponse>('/api/records/list', body, options);
}

export function searchRecords(body: { query: string; limit?: number; scope?: string }, options?: { signal?: AbortSignal }): Promise<RecordsSearchResponse> {
  return postJson<RecordsSearchResponse>('/api/records/search', body, options);
}

export function getRecordDetail(body: { recordId: string }, options?: { signal?: AbortSignal }): Promise<RecordDetailResponse> {
  return postJson<RecordDetailResponse>('/api/records/detail', body, options);
}

export const api = {
  createSession,
  validateDirectory,
  listPathHistory,
  savePathHistory,
  deletePathHistory,
  clearPathHistory,
  listRecords,
  searchRecords,
  getRecordDetail,
};

export default api;
