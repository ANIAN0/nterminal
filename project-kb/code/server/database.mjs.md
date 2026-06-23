---
type: Project Code
title: server/database.mjs
description: 管理 nterminal 本地 SQLite 连接、持久化模型和同步查询原语。
source_path: server/database.mjs
tags: [sqlite, database, history]
timestamp: 2026-06-23T00:00:00+08:00
---

# server/database.mjs

## 功能与职责

提供单进程 SQLite 连接及对话来源、会话消息、工作区和标签元数据的持久化 API。公开 CRUD 保持同步调用，写入使用事务，调用方不得持有另一个数据库事实源。

## 关键逻辑与边界

- 初始化必须先完成一次性备份和版本化迁移，再向服务暴露连接。
- 迁移兼容 1.2 数据，并保持原消息数量；失败必须回滚，备份用于人工恢复。
- 三字符以上历史查询使用 FTS5 trigram，一至二字符使用参数化且有限制的 LIKE。
- 会话历史由 `conversation_sessions.session_key` 串联消息，单消息详情/删除 helper 已废弃；历史 UI 必须通过 `server/history-service.mjs` 获取会话级数据。
- 用户真实 `data/nterminal.db` 只用于只读复制验证；自动测试只修改临时副本。

## 关联知识

- [系统结构](../../architecture/system-structure.md) - 数据库是持久化事实源，PTY 运行态不在此恢复。
- `server/database-migrations.mjs` 与本文件共同维护 schemaVersion，迁移 SQL 不应散落到 HTTP 层。

## 测试与验证

- `test/database.test.mjs` 覆盖既有 CRUD。
- `test/backend/integration/database-migration.test.mjs` 覆盖 1.2 备份、迁移、幂等和回滚。
- `test/backend/integration/history-search.test.mjs` 覆盖 FTS/LIKE 正确性和性能。
- `test/backend/integration/history-api.test.mjs` 和 `history-session-search.test.mjs` 覆盖会话级历史服务。

## 修改注意事项

修改 schema 时同步迁移版本、备份策略、触发器和下游导入字段；必须在真实 1.2 副本及空库上各验证一次。

# Citations

- [源码](../../../server/database.mjs)
- [已确认技术方案](../../../workplace/1.3/tech-design/2026-06-23-product-delivery-closure-tech-design.md)
