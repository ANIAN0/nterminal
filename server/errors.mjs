/**
 * 对话来源相关错误的统一语义层。
 * 把 Node/SQLite 原生错误码与同步层自定义错误码归一为带 retryable / contextId 的错误包络，
 * 让同步引擎、HTTP 路由与前端都能消费稳定的错误契约。
 */

// SOURCE_ERROR_CATALOG：对话来源错误码目录，message 给前端展示、retryable 决定是否可重试。
const SOURCE_ERROR_CATALOG = {
  SOURCE_MISSING: { message: '对话来源不存在或不可访问', retryable: true },
  SOURCE_PERMISSION: { message: '没有权限读取对话来源', retryable: false },
  SOURCE_SCHEMA: { message: '对话来源结构不受支持', retryable: false },
  SOURCE_LOCKED: { message: '对话来源暂时被占用', retryable: true },
  SOURCE_DISK_FULL: { message: '没有足够空间完成同步', retryable: false },
  SOURCE_SNAPSHOT: { message: '无法创建对话来源快照', retryable: true },
  PARSE_ERROR: { message: '无法解析对话来源', retryable: true },
  SOURCE_NOT_FOUND: { message: '对话来源不存在', retryable: false },
};

// NATIVE_SOURCE_CODES：把 Node 与 SQLite 的原生 errno 映射到上层的 SOURCE_* 错误码。
const NATIVE_SOURCE_CODES = new Map([
  ['ENOENT', 'SOURCE_MISSING'],
  ['EACCES', 'SOURCE_PERMISSION'],
  ['EPERM', 'SOURCE_PERMISSION'],
  ['SQLITE_ERROR', 'SOURCE_SCHEMA'],
  ['SQLITE_BUSY', 'SOURCE_LOCKED'],
  ['SQLITE_LOCKED', 'SOURCE_LOCKED'],
  ['SQLITE_FULL', 'SOURCE_DISK_FULL'],
]);

// createContextId：为单次失败生成可在日志和前端之间关联的稳定 contextId。
function createContextId() {
  return `ctx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 构造一个统一的错误包络，未知 code 兜底为 PARSE_ERROR。
 * @param {{code: string, retryable?: boolean, contextId?: string}} params
 */
export function createErrorEnvelope({ code, retryable, contextId }) {
  const known = SOURCE_ERROR_CATALOG[code] || { message: '操作失败', retryable: false };
  return {
    code,
    message: known.message,
    retryable: retryable ?? known.retryable,
    contextId: contextId || createContextId(),
  };
}

/**
 * 把任意错误对象映射成对话来源错误包络。
 * 命中 NATIVE_SOURCE_CODES 的优先映射；未命中且 code 不在目录里时退化为 PARSE_ERROR。
 * @param {Error & {code?: string}} error
 * @param {{contextId?: string}} [options]
 */
export function mapSourceError(error, options = {}) {
  const mappedCode = NATIVE_SOURCE_CODES.get(error?.code);
  const code = mappedCode || (SOURCE_ERROR_CATALOG[error?.code] ? error.code : 'PARSE_ERROR');
  return createErrorEnvelope({
    code,
    retryable: SOURCE_ERROR_CATALOG[code]?.retryable,
    contextId: options.contextId,
  });
}

/**
 * 取出指定错误码对应的展示文案；未知 code 兜底为 PARSE_ERROR 的文案。
 * @param {string} code
 */
export function getSourceErrorMessage(code) {
  return (SOURCE_ERROR_CATALOG[code] || SOURCE_ERROR_CATALOG.PARSE_ERROR).message;
}
