/**
 * Input validation helpers (技术方案 C-001 / 3.4)
 *
 * 提供三类校验：
 *   - validateCwd / validatePath / validateQuery：参数合法性
 *   - readBoundedRequestBody：1MiB body 上限
 *   - checkDirectoryExists：cwd 必须是已存在目录
 *
 * 校验函数一律返回 result 对象 {ok:true} / {ok:false, code, message}，
 * 由 HTTP handler 决定如何映射到响应壳。
 */

import { statSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

export const MAX_CWD_LENGTH = 4096;
export const MAX_PATH_LENGTH = 4096;
export const MAX_QUERY_LENGTH = 256;
export const MAX_BODY_LENGTH = 1 << 20; // 1 MiB

/**
 * 判断是否为 UNC 路径（\\server\share 形式）
 */
export function isUncPath(value) {
  return typeof value === 'string' && /^\\\\[^\\]/.test(value);
}

/**
 * 校验 cwd 入参：非空、长度、UNC
 * 不做 fs.stat（单独走 checkDirectoryExists，给上层区分 directory_not_found / path_not_directory 的可能）
 */
export function validateCwd(value) {
  if (typeof value !== 'string' || !value) {
    return { ok: false, code: 'invalid_cwd', message: 'cwd 必须是非空字符串' };
  }
  if (value.length > MAX_CWD_LENGTH) {
    return { ok: false, code: 'path_too_long', message: `cwd 长度超过 ${MAX_CWD_LENGTH}` };
  }
  if (isUncPath(value) && process.platform !== 'win32') {
    return { ok: false, code: 'unc_not_allowed', message: 'UNC 路径仅在 Windows 允许' };
  }
  return { ok: true };
}

/**
 * 校验 path 入参（用于 path-history 等）
 */
export function validatePath(value, fieldName = 'path') {
  if (typeof value !== 'string' || !value) {
    return { ok: false, code: 'invalid_path', message: `${fieldName} 必须是非空字符串` };
  }
  if (value.length > MAX_PATH_LENGTH) {
    return { ok: false, code: 'path_too_long', message: `${fieldName} 长度超过 ${MAX_PATH_LENGTH}` };
  }
  if (isUncPath(value) && process.platform !== 'win32') {
    return { ok: false, code: 'unc_not_allowed', message: 'UNC 路径仅在 Windows 允许' };
  }
  return { ok: true };
}

/**
 * 校验 query 入参。可选；非空时检查长度
 */
export function validateQuery(value, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) {
      return { ok: false, code: 'query_empty', message: 'query 不能为空' };
    }
    return { ok: true };
  }
  if (typeof value !== 'string') {
    return { ok: false, code: 'query_invalid', message: 'query 必须是字符串' };
  }
  if (value.length > MAX_QUERY_LENGTH) {
    return { ok: false, code: 'query_too_long', message: `query 长度超过 ${MAX_QUERY_LENGTH}` };
  }
  return { ok: true };
}

/**
 * 校验 cwd 真实存在且是目录
 *  - 不存在 → directory_not_found
 *  - 存在但不是目录 → path_not_directory
 *  - 成功 → { ok: true, resolved, displayName }
 */
export function checkDirectoryExists(value) {
  const resolved = resolvePath(value);
  let stats;
  try {
    stats = statSync(resolved);
  } catch {
    return { ok: false, code: 'directory_not_found', message: `路径不存在: ${resolved}` };
  }
  if (!stats.isDirectory()) {
    return { ok: false, code: 'path_not_directory', message: '路径不是目录' };
  }
  const parts = resolved.replace(/[\\/]+$/, '').split(/[\\/]/);
  let displayName = parts[parts.length - 1] || resolved;
  // Windows 盘符根: "C:\" -> "C:"
  if (process.platform === 'win32' && /^[A-Za-z]:$/.test(displayName)) {
    displayName = resolved;
  }
  return { ok: true, resolved, displayName };
}

/**
 * 读取请求 body，超出 maxBytes 立即 reject('body_too_large')。
 * 替代裸 readRequestBody。
 */
export function readBoundedRequestBody(req, maxBytes = MAX_BODY_LENGTH) {
  return new Promise((resolve, reject) => {
    let body = '';
    let total = 0;
    let aborted = false;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      if (aborted) return;
      total += Buffer.byteLength(chunk, 'utf-8');
      if (total > maxBytes) {
        aborted = true;
        const err = new Error('body_too_large');
        err.code = 'body_too_large';
        try { req.destroy(); } catch { /* noop */ }
        reject(err);
        return;
      }
      body += chunk;
    });
    req.on('end', () => { if (!aborted) resolve(body); });
    req.on('error', (err) => { if (!aborted) reject(err); });
  });
}
