/**
 * 共享类型定义（与 server 端契约一致）
 * 任何字段类型变更需同步 server 端 handler 与 interaction-recorder / path-history-store
 *
 * 与技术方案 3.4 / 3.5 / 4.6 一一对应。
 */

export type EndState = 'recording' | 'idle' | 'session_exit' | 'error';

export interface OkResponse<T> {
  ok: true;
  data: T;
}

export interface ErrorResponse {
  ok: false;
  error: { code: string; message: string };
}

export type ApiResponse<T> = OkResponse<T> | ErrorResponse;

// ---- Session（设计 3.4 /api/session/create）----
export interface SessionInfo {
  id: string;
  cwd: string;
  command: string;
  status: 'running' | 'ended' | 'error';
  startedAt: string;
  error?: string | null;
}

// ---- Directory validate（设计 3.4 /api/directory/validate）----
export interface ValidateResponse {
  ok: boolean;
  cwd?: string;
  displayName?: string;
  error?: string;
}

// ---- Path history（设计 3.5）----
export interface PathHistoryItem {
  path: string;
  displayName: string;
  lastUsedAt: string;
  useCount: number;
  exists: boolean;
}

export interface PathHistoryListResponse {
  items: PathHistoryItem[];
}

export interface PathHistorySaveResponse {
  item: PathHistoryItem;
}

// ---- Records（设计 3.4 / 3.5）----
export interface RecordSummary {
  recordId: string;
  userTextPreview: string;
  outputTextPreview: string;
  startedAt: string;
  endedAt: string | null;
  endState: EndState;
}

export interface RecordSearchItem {
  recordId: string;
  userTextPreview: string;
  outputTextPreview: string;
  cwd: string;
  displayName: string;
  sessionId: string;
  startedAt: string;
  endState: EndState;
}

export interface HistoryGroupSession {
  sessionId: string;
  command: string;
  startedAt: string;
  endedAt: string | null;
  records: RecordSummary[];
}

export interface HistoryGroup {
  cwd: string;
  displayName: string;
  sessions: HistoryGroupSession[];
}

export interface RecordsListResponse {
  groups: HistoryGroup[];
  total: number;
}

export interface RecordsSearchResponse {
  items: RecordSearchItem[];
}

export interface InteractionRecord {
  id: string;
  sessionId: string;
  cwd: string;
  command: string;
  userText: string;
  outputText: string;
  startedAt: string;
  endedAt: string | null;
  endState: EndState;
  error: string | null;
  userTextPreview: string;
  outputTextPreview: string;
}

export interface RecordDetailResponse {
  record: InteractionRecord;
}
