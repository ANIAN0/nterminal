/**
 * InteractionRecord JSONL 记录器
 * 负责将每轮用户输入、终端输出和结束判定写入 JSONL
 *
 * 公共 API（设计 3.4 / C-004）：
 *   - beginTurn({ sessionId, cwd, command, userText }) -> recordId
 *   - appendOutput(recordId, chunk)
 *   - finishTurn(recordId, { endState, error })
 *   - listRecords({ query, cwd, sessionId, limit=50, offset=0 }) -> { groups, total }
 *   - searchRecords({ query, limit=20 }) -> { items }
 *   - getRecordById(recordId)
 *   - normalizeEndState(state)
 *   - readRecentRecords(limit)
 *   - getSessionRecords(sessionId)
 *
 * endState 新值：recording | idle | session_exit | error
 * 旧值读取侧映射：done/uncertain_end -> idle, failed -> error
 * 写侧 finishTurn 收到旧值或非法值直接抛错（C-004）
 *
 * 数据文件：process.env.DATA_DIR || process.cwd()/data/interactions.jsonl
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { makePreview } from './text-utils.mjs';

const PREVIEW_USER_THRESHOLD = 200;
const PREVIEW_OUTPUT_THRESHOLD = 500;

const VALID_END_STATES = new Set(['recording', 'idle', 'session_exit', 'error']);

// 旧值 → 新值 映射
const LEGACY_END_STATE_MAP = new Map([
  ['done', 'idle'],
  ['uncertain_end', 'idle'],
  ['failed', 'error'],
]);

function getDataDir() {
  return process.env.DATA_DIR || join(process.cwd(), 'data');
}

function getJsonlFile() {
  return join(getDataDir(), 'interactions.jsonl');
}

function ensureDataDir() {
  const dataDir = getDataDir();
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
}

/**
 * 读侧：合法新值透传；旧值映射；其他 → 'idle'
 */
export function normalizeEndState(state) {
  if (VALID_END_STATES.has(state)) return state;
  if (LEGACY_END_STATE_MAP.has(state)) return LEGACY_END_STATE_MAP.get(state);
  return 'idle';
}

function getRecordStore() {
  if (!globalThis.__interactionRecords) {
    globalThis.__interactionRecords = new Map();
  }
  return globalThis.__interactionRecords;
}

export function beginTurn({ sessionId, cwd, command, userText }) {
  const recordId = randomUUID();
  const startedAt = new Date().toISOString();

  const record = {
    id: recordId,
    sessionId,
    cwd,
    command,
    userText,
    outputText: '',
    startedAt,
    endedAt: null,
    endState: 'recording',
    error: null,
    userTextPreview: makePreview(userText || '', 'user'),
    outputTextPreview: '',
  };

  getRecordStore().set(recordId, record);
  return recordId;
}

export function appendOutput(recordId, chunk) {
  const record = getRecordStore().get(recordId);
  if (!record) {
    throw new Error(`记录 ${recordId} 不存在`);
  }
  record.outputText += chunk;
}

/**
 * 写侧：endState 必须在 VALID_END_STATES 中；不通过直接抛错（C-004）
 */
export function finishTurn(recordId, { endState, error = null }) {
  if (!VALID_END_STATES.has(endState)) {
    throw new Error(
      `finishTurn 收到非法 endState: ${JSON.stringify(endState)}；合法值: ${[...VALID_END_STATES].join(', ')}`,
    );
  }
  const store = getRecordStore();
  const record = store.get(recordId);
  if (!record) {
    throw new Error(`记录 ${recordId} 不存在`);
  }

  record.endedAt = new Date().toISOString();
  record.endState = endState;
  record.error = error;
  record.outputTextPreview = makePreview(record.outputText || '', 'output');
  if (!record.userTextPreview) {
    record.userTextPreview = makePreview(record.userText || '', 'user');
  }

  ensureDataDir();
  appendFileSync(getJsonlFile(), JSON.stringify(record) + '\n', 'utf-8');
  store.delete(recordId);

  return record;
}

function readAllRecords() {
  const file = getJsonlFile();
  if (!existsSync(file)) return [];
  let content;
  try {
    content = readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  const lines = content.split('\n').filter((line) => line.trim());
  return lines
    .map((line) => {
      try {
        const r = JSON.parse(line);
        r.endState = normalizeEndState(r.endState);
        // C-013：旧字段在读侧丢弃
        if ('injectionText' in r) delete r.injectionText;
        if ('writePreview' in r) delete r.writePreview;
        if (typeof r.userTextPreview !== 'string') {
          r.userTextPreview = makePreview(r.userText || '', 'user');
        }
        if (typeof r.outputTextPreview !== 'string') {
          r.outputTextPreview = makePreview(r.outputText || '', 'output');
        }
        return r;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function matchesQuery(record, query) {
  if (!query) return true;
  const q = String(query).toLowerCase();
  if ((record.userText || '').toLowerCase().includes(q)) return true;
  if ((record.outputText || '').toLowerCase().includes(q)) return true;
  return false;
}

function toRecordSummary(record) {
  return {
    recordId: record.id,
    userTextPreview: record.userTextPreview,
    outputTextPreview: record.outputTextPreview,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    endState: record.endState,
  };
}

function toSearchItem(record) {
  return {
    recordId: record.id,
    userTextPreview: record.userTextPreview,
    outputTextPreview: record.outputTextPreview,
    cwd: record.cwd,
    displayName: basename(record.cwd || ''),
    sessionId: record.sessionId,
    startedAt: record.startedAt,
    endState: record.endState,
  };
}

/**
 * 纯函数：record[] → cwd → sessionId 两级分组
 */
function groupRecords(records) {
  const byCwd = new Map();
  for (const r of records) {
    const cwd = r.cwd || '';
    if (!byCwd.has(cwd)) {
      byCwd.set(cwd, { cwd, displayName: basename(cwd) || cwd, sessions: new Map() });
    }
    const group = byCwd.get(cwd);
    const sessionId = r.sessionId || '';
    if (!group.sessions.has(sessionId)) {
      group.sessions.set(sessionId, {
        sessionId,
        command: r.command || '',
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        records: [],
      });
    }
    group.sessions.get(sessionId).records.push(toRecordSummary(r));
  }
  // Map → Array
  const groups = [];
  for (const g of byCwd.values()) {
    const sessions = Array.from(g.sessions.values());
    for (const s of sessions) {
      s.records.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
    }
    sessions.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
    groups.push({ cwd: g.cwd, displayName: g.displayName, sessions });
  }
  groups.sort((a, b) => {
    const at = a.sessions[0]?.startedAt || '';
    const bt = b.sessions[0]?.startedAt || '';
    return new Date(bt) - new Date(at);
  });
  return groups;
}

/**
 * 搜索：query 必填；空 query 返空（防御性，HTTP 层已先拒绝）
 */
export function searchRecords({ query = '', limit = 20 } = {}) {
  if (!query) {
    return { items: [] };
  }
  const all = readAllRecords();
  const matched = all.filter((r) => matchesQuery(r, query));
  matched.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  const sliced = matched.slice(0, Math.max(0, limit));
  return { items: sliced.map(toSearchItem) };
}

/**
 * 列表：按 query/cwd/sessionId 过滤 → 分页 → 分组
 */
export function listRecords({ query = '', cwd = null, sessionId = null, limit = 20, offset = 0 } = {}) {
  const all = readAllRecords();
  const filtered = all.filter((r) => {
    if (cwd && r.cwd !== cwd) return false;
    if (sessionId && r.sessionId !== sessionId) return false;
    if (query && !matchesQuery(r, query)) return false;
    return true;
  });
  filtered.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  const total = filtered.length;
  const page = filtered.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(0, limit));
  return { groups: groupRecords(page), total };
}

export function getRecordById(recordId) {
  if (!recordId) return null;
  const all = readAllRecords();
  return all.find((rec) => rec.id === recordId) || null;
}

export function readRecentRecords(limit = 10) {
  return readAllRecords().slice(0, Math.max(0, limit));
}

export function getSessionRecords(sessionId) {
  return readAllRecords().filter((r) => r.sessionId === sessionId);
}

export default {
  beginTurn,
  appendOutput,
  finishTurn,
  listRecords,
  searchRecords,
  getRecordById,
  normalizeEndState,
  readRecentRecords,
  getSessionRecords,
};
