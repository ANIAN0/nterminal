import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

function checkIgnore(relativePath) {
  // 使用真实 Git 规则验证追踪边界，避免仅检查文本却遗漏父目录规则。
  return spawnSync('git', ['check-ignore', '-q', relativePath], { cwd: root }).status === 0;
}

describe('研发工作区入口', () => {
  it('项目规则和知识库互相链接', () => {
    const rules = read('PROJECT_RULES.md');
    const kbIndex = read('project-kb/index.md');

    expect(rules).toContain('project-kb/index.md');
    expect(rules).toContain('project-kb/code/index.md');
    expect(kbIndex).toContain('../PROJECT_RULES.md');
    expect(read('project-kb/log.md')).toContain('2026-06-23');
    expect(read('project-kb/code/index.md')).toContain('vitest.config.mjs.md');
  });

  it('只放行当前 1.3 研发文档', () => {
    expect(checkIgnore('workplace/1.3/implementation-planning/2026-06-23-product-delivery-closure.md')).toBe(false);
    expect(checkIgnore('workplace/1.2/placeholder.md')).toBe(true);
    expect(checkIgnore('data/nterminal.db')).toBe(true);
    expect(checkIgnore('logs/server.log')).toBe(true);
  });
});

describe('正式质量命令', () => {
  it('脚本和 Vitest 不引用历史工作区', () => {
    const packageJson = JSON.parse(read('package.json'));
    const vitestConfig = read('vitest.config.mjs');
    const serializedScripts = JSON.stringify(packageJson.scripts);

    expect(serializedScripts).not.toMatch(/workplace\/(?:1\.1|1\.2|archive)/);
    expect(vitestConfig).toContain("'test/**/*.{test,spec}.{js,mjs,ts,tsx}'");
    expect(vitestConfig).not.toMatch(/workplace\/(?:1\.1|1\.2|archive)/);
  });
});
