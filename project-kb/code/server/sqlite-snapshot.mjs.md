---
type: Project Code
title: server/sqlite-snapshot.mjs
description: 使用 SQLite Online Backup 在临时目录创建活动数据库一致快照。
source_path: server/sqlite-snapshot.mjs
tags: [sqlite, snapshot, opencode]
timestamp: 2026-06-23T00:00:00+08:00
---

# server/sqlite-snapshot.mjs

## 功能与职责

只读打开外部 SQLite 来源，通过 better-sqlite3 online backup 创建一致快照；busy/locked 最多三次有界退避，操作完成、失败或重试时都清理临时目录。

## 修改风险与验证

临时路径必须位于系统 Temp，禁止删除越界路径；权限、schema 和空间错误不得无意义重试。修改后运行 WAL 并发写和失败清理测试。

# Citations

- [源码](../../../server/sqlite-snapshot.mjs)
- [OpenCode 调研](../../../workplace/1.3/tech-design/2026-06-23-product-delivery-closure-tech-design/research/RT-001-opencode-consistent-read.md)
