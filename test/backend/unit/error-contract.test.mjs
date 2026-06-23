import { describe, expect, it } from 'vitest';
import { createErrorEnvelope, mapSourceError } from '../../../server/errors.mjs';

describe('错误契约', () => {
  it.each([
    ['ENOENT', 'SOURCE_MISSING', true, '对话来源不存在或不可访问'],
    ['EACCES', 'SOURCE_PERMISSION', false, '没有权限读取对话来源'],
    ['SQLITE_ERROR', 'SOURCE_SCHEMA', false, '对话来源结构不受支持'],
    ['SQLITE_BUSY', 'SOURCE_LOCKED', true, '对话来源暂时被占用'],
    ['SQLITE_FULL', 'SOURCE_DISK_FULL', false, '没有足够空间完成同步'],
  ])('%s 映射为安全、稳定、可重试的来源错误', (nativeCode, code, retryable, message) => {
    const error = Object.assign(new Error('C:/secret/opencode.db SELECT * FROM message stack trace'), { code: nativeCode });
    expect(mapSourceError(error, { contextId: 'ctx-1' })).toEqual({ code, message, retryable, contextId: 'ctx-1' });
  });

  it('错误 envelope 不暴露 SQL、堆栈和本地文件细节', () => {
    const envelope = createErrorEnvelope({
      code: 'SOURCE_SCHEMA',
      message: 'SQLITE_ERROR near SELECT at C:/Users/me/.local/share/opencode/opencode.db\nstack',
      retryable: false,
      contextId: 'ctx-2',
    });

    expect(envelope).toEqual({
      code: 'SOURCE_SCHEMA',
      message: '对话来源结构不受支持',
      retryable: false,
      contextId: 'ctx-2',
    });
  });
});
