import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDatabase, getSchemaVersion, initializeDatabase } from '../../../server/database.mjs';
import { createV12Database } from '../../fixtures/create-v12-database.mjs';

let tempDir;

afterEach(() => {
  closeDatabase();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
}

describe('1.2 数据库迁移', () => {
  it('先备份，再以单个事务幂等升级到 1.3', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'nterminal-migration-'));
    const dbPath = join(tempDir, 'nterminal.db');
    const backupPath = `${dbPath}.pre-1.3.bak`;
    createV12Database(dbPath);
    const beforeBytes = readFileSync(dbPath).byteLength;

    const db = initializeDatabase(dbPath);

    expect(existsSync(backupPath)).toBe(true);
    expect(readFileSync(backupPath).byteLength).toBe(beforeBytes);
    expect(getSchemaVersion()).toBe(13);
    expect(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS count FROM conversations').get().count).toBe(2);
    expect(columns(db, 'conversation_sessions')).toContain('session_key');
    expect(columns(db, 'conversations')).toEqual(expect.arrayContaining([
      'session_key', 'source_file', 'native_message_id', 'message_index',
    ]));
    expect(columns(db, 'conversation_sources')).toEqual(expect.arrayContaining([
      'enabled', 'sync_state', 'needs_reconcile', 'last_error_code',
    ]));
    expect(columns(db, 'tab_sessions')).toEqual(expect.arrayContaining([
      'label', 'create_request_id', 'ended_at', 'exit_code', 'exit_signal',
    ]));
    expect(db.prepare("SELECT needs_reconcile FROM conversation_sources WHERE id='source-1'").get()).toEqual({ needs_reconcile: 1 });
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name='conversations_fts'").get().sql).toContain('trigram');

    const backupBytes = readFileSync(backupPath).byteLength;
    closeDatabase();
    initializeDatabase(dbPath);
    expect(getSchemaVersion()).toBe(13);
    expect(readFileSync(backupPath).byteLength).toBe(backupBytes);
    const readonlyDb = new Database(dbPath, { readonly: true });
    expect(readonlyDb.prepare('SELECT COUNT(*) AS count FROM conversations').get().count).toBe(2);
    readonlyDb.close();
  });

  it('迁移 SQL 失败时保留原记录并回滚版本表', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'nterminal-migration-failure-'));
    const dbPath = join(tempDir, 'nterminal.db');
    createV12Database(dbPath);
    const poisonedDb = new Database(dbPath);
    // 同名视图让迁移建表确定失败，用于证明事务不会留下半迁移结构。
    poisonedDb.exec('CREATE VIEW conversation_sessions AS SELECT id AS session_key FROM conversations');
    poisonedDb.close();

    expect(() => initializeDatabase(dbPath)).toThrow();
    expect(existsSync(`${dbPath}.pre-1.3.bak`)).toBe(true);

    const readonlyDb = new Database(dbPath, { readonly: true });
    expect(readonlyDb.prepare('SELECT COUNT(*) AS count FROM conversations').get().count).toBe(2);
    expect(readonlyDb.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get().count).toBe(0);
    readonlyDb.close();
  });

  it('备份目标不可写时不开始迁移', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'nterminal-backup-failure-'));
    const dbPath = join(tempDir, 'nterminal.db');
    createV12Database(dbPath);
    // 以同名目录稳定制造备份失败，避免 Windows 管理员权限绕过只读位。
    mkdirSync(`${dbPath}.pre-1.3.bak`);

    expect(() => initializeDatabase(dbPath)).toThrow();
    const readonlyDb = new Database(dbPath, { readonly: true });
    expect(readonlyDb.prepare('SELECT COUNT(*) AS count FROM conversations').get().count).toBe(2);
    expect(readonlyDb.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name='schema_migrations'").get().count).toBe(0);
    readonlyDb.close();
  });
});
