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

// 历史页按 cwd/session 分组的列表响应（interaction-recorder 老格式）
export interface RecordsListGroupedResponse {
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
  /** 最终输出文本：finalize 时用 headless grid snapshot 写入（无 ANSI、无 TUI 重绘重复）。旧记录是原始 PTY 字节流。 */
  outputText: string;
  /** 原始 PTY 字节流（仅新格式记录有）。outputText 是清理版，outputTextRaw 保留以备调试/未来重放。 */
  outputTextRaw?: string;
  /** 服务端注入的清理版输出（详情接口）；新记录 = outputText，旧记录 = headless 重放结果 */
  outputTextClean?: string;
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

// ---- Tab（终端标签）----
// status 与后端 PTY 状态对齐：connecting=WS 握手, ready=PTY 运行中,
// exited=PTY 已退出（保留只读）, error=PTY 创建/连接失败
export interface TabInfo {
  id: string;
  label: string | null;
  status: 'connecting' | 'ready' | 'running' | 'ended' | 'exited' | 'error';
  cwd?: string;
  workspaceId?: string;
}

// 与后端 session_limit_reached=8 对齐：最多 8 个活跃标签
export const MAX_TABS = 8;

// ---- Workspace（工作区）----
export interface Workspace {
  id: string;
  displayName: string | null;
  createdAt: string;
  lastActiveAt: string | null;
  sessionCount: number;
}

// ---- Completion（补全项）----
export interface CompletionItem {
  userText: string;
  count: number;
  lastUsedAt: string;
}

// ---- ConversationSource（对话源）----
export interface ConversationSource {
  id: string;
  path: string;
  agentType: 'claude' | 'pi' | 'codex' | 'opencode';
  label: string | null;
  lastSyncedAt: string | null;
  lastSuccessAt?: string | null;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  lastErrorAt?: string | null;
  syncState?: 'idle' | 'active' | 'syncing' | 'error' | string;
  recordCount: number;
  status: 'active' | 'paused' | 'error';
}

// ---- ConversationRecord（导入的对话记录）----
export interface ConversationRecord {
  id: string;
  sourceId: string;
  sessionId: string | null;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | null;
  toolCalls: string | null;
  toolCallId: string | null;
  metadata: string | null;
  userText: string | null;
  endedAt: string | null;
  createdAt: string;
  cwd: string | null;
}

export interface ConversationSearchItem {
  conversation: ConversationRecord;
  snippet: string | null;
  rank: number;
}

export interface HistorySourceState {
  sourceId: string;
  agentType: 'claude' | 'pi' | 'codex' | 'opencode';
  label: string | null;
  path: string;
  state: 'active' | 'paused' | 'error';
  syncState?: string;
  recordCount?: number;
  lastSyncedAt?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  errorAt?: string | null;
}

export interface HistorySessionSummary {
  sessionKey: string;
  sourceId: string;
  nativeSessionId: string | null;
  cwd: string | null;
  title: string;
  startedAt: string | null;
  endedAt: string | null;
  sourceFile?: string | null;
  messageCount: number;
  snippet: string | null;
}

export interface HistoryWorkspaceGroup {
  cwd: string;
  displayName: string;
  sessions: HistorySessionSummary[];
}

export interface HistorySourceGroup {
  sourceId: string;
  agentType: 'claude' | 'pi' | 'codex' | 'opencode';
  label: string | null;
  state: 'active' | 'paused' | 'error';
  workspaces: HistoryWorkspaceGroup[];
}

export interface HistorySessionsResponse {
  groups: HistorySourceGroup[];
  pagination: {
    limit: number;
    hasMore: boolean;
    searchMode: 'all' | 'like' | 'fts';
    nextCursor: string | null;
  };
  sourceStates: HistorySourceState[];
}

export interface HistoryMessage {
  id: string;
  sourceId: string;
  sessionId: string | null;
  sessionKey: string;
  nativeMessageId: string | null;
  messageIndex: number;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | null;
  toolCalls: string | null;
  toolCallId: string | null;
  metadata: string | null;
  userText: string | null;
  endedAt: string | null;
  createdAt: string;
  cwd: string | null;
  sourceFile: string | null;
}

export interface HistorySessionDetailResponse {
  session: HistorySessionSummary;
  source: HistorySourceState;
  messages: HistoryMessage[];
}

// ---- API 请求/响应类型 ----
export interface ConversationSourceAddRequest {
  path: string;
  agentType: string;
  label?: string;
}

export interface CompletionQueryRequest {
  prefix: string;
  limit?: number;
}

export interface CompletionQueryResponse {
  items: CompletionItem[];
}

export interface RecordsListRequest {
  query?: string;
  cwd?: string | null;
  sessionId?: string | null;
  limit?: number;
  offset?: number;
  cursor?: string;
  agentType?: string;
}

// 导入引擎 cursor 分页列表响应（SQLite conversations 表）
export interface RecordsListCursorResponse {
  items: ConversationRecord[];
  nextCursor: string | null;
  total: number;
}
