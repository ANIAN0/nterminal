import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, getDb, initializeDatabase } from '../../../server/database.mjs';
import { WorkspaceServiceError, createWorkspaceService } from '../../../server/workspace-service.mjs';

let tempDir;

afterEach(() => {
  closeDatabase();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function setup() {
  tempDir = mkdtempSync(join(tmpdir(), 'nterminal-workspace-'));
  initializeDatabase(join(tempDir, 'nterminal.db'));
  const createPty = vi.fn(({ cwd }) => ({ id: 'pty-1', cwd, status: 'running' }));
  const closePty = vi.fn(() => true);
  return { service: createWorkspaceService({ db: getDb(), createPty, closePty }), createPty, closePty };
}

describe('workspace service', () => {
  it('同 cwd 重复创建只保留一个规范化工作区', async () => {
    const { service } = setup();
    const [first, duplicate] = await Promise.all([
      Promise.resolve(service.createWorkspace({ cwd: tempDir, requestId: 'workspace-request' })),
      Promise.resolve(service.createWorkspace({ cwd: `${tempDir}/.`, requestId: 'workspace-request' })),
    ]);
    expect(first.workspace.id).toBe(resolve(tempDir));
    expect(duplicate).toMatchObject({ workspace: first.workspace, deduplicated: true });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM workspaces').get().count).toBe(1);
  });

  it('标签继承工作区 cwd，同 requestId 不重复 spawn', () => {
    const { service, createPty } = setup();
    const workspace = service.createWorkspace({ cwd: tempDir, requestId: 'workspace-request' }).workspace;
    const first = service.createTab(workspace.id, { requestId: 'tab-request', label: 'Shell' });
    const duplicate = service.createTab(workspace.id, { requestId: 'tab-request', label: 'Shell' });
    expect(first.tab.cwd).toBe(workspace.id);
    expect(duplicate).toMatchObject({ tab: first.tab, deduplicated: true });
    expect(createPty).toHaveBeenCalledTimes(1);
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM tab_sessions').get().count).toBe(1);
  });

  it('活动标签必须显式关闭后才能删除', () => {
    const { service, closePty } = setup();
    const workspace = service.createWorkspace({ cwd: tempDir, requestId: 'workspace-request' }).workspace;
    const { tab } = service.createTab(workspace.id, { requestId: 'tab-request' });
    expect(() => service.deleteTab(tab.id)).toThrow(expect.objectContaining({ code: 'ACTIVE_TAB_REQUIRES_CLOSE', status: 409 }));
    expect(service.closeActiveTab(tab.id)).toMatchObject({ closed: true });
    expect(closePty).toHaveBeenCalledWith(tab.id);
    expect(service.deleteTab(tab.id)).toEqual({ deleted: true });
  });

  it('空 cwd 和不存在目录返回稳定错误', () => {
    const { service } = setup();
    expect(() => service.createWorkspace({ cwd: '', requestId: 'empty' })).toThrow(WorkspaceServiceError);
    expect(() => service.createWorkspace({ cwd: join(tempDir, 'missing'), requestId: 'missing' }))
      .toThrow(expect.objectContaining({ code: 'INVALID_CWD' }));
  });
});
