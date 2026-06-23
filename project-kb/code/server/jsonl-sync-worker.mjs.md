---
type: Project Code
title: server/jsonl-sync-worker.mjs
description: 在 worker 线程完成 JSONL 类来源解析、reconcile 和目标库原子写入。
source_path: server/jsonl-sync-worker.mjs
tags: [import, worker, jsonl, sqlite]
timestamp: 2026-06-23T12:05:00+08:00
---

# server/jsonl-sync-worker.mjs

## 功能与职责

该文件把 Claude、Codex、Pi 等 JSONL/文件树来源的解析、全量 reconcile、增量替换和 FTS 写入移出 HTTP 主线程。worker 使用独立 better-sqlite3 连接写入同一个 nterminal 目标库，只向主线程返回统计和结构化错误，不传输对话正文。

## 关键逻辑与边界

- worker 从 `workerData` 接收来源配置和目标库路径，避免在主线程执行大文件扫描和大量 INSERT。
- 独立连接启用 WAL、foreign keys 和 busy timeout，原因是导入期间前端 HTTP 查询仍需要读取同一数据库。
- 实际导入规则复用 `server/conversation-import.mjs` 的 `performJsonlSourceSync`，避免 worker 与主路径出现两套 reconcile 语义。
- worker 只负责一次同步，不持有 watcher、scheduler 或 source mutex；并发合并仍由主线程 import engine 管理。

## 强关联文件

- [server/conversation-import.mjs](conversation-import.mjs.md)：提供 JSONL 同步规则和主线程调度入口。
- [server/conversation-parser.mjs](conversation-parser.mjs.md)：检测文件格式并返回统一会话契约。
- [server/database.mjs](database.mjs.md)：定义目标库 schema、FTS 和来源状态字段。

## 测试与验证

- `test/backend/integration/jsonl-worker-responsiveness.test.mjs` 覆盖 10,000 条 JSONL 导入期间主线程心跳不被长事务阻塞。
- T-003 聚焦回归同时覆盖 parser contract、reconcile、错误隔离、OpenCode worker 和 JSONL worker。

## 修改风险

修改该文件时必须验证 worker 启动参数、目标库连接关闭、错误回传和主线程响应性；如果改动 `performJsonlSourceSync` 的返回结构，也必须同步检查主线程 `syncSource` 调用方和设置页诊断。

# Citations

- [源码](../../../server/jsonl-sync-worker.mjs)
- [T-003 证据](../../../workplace/1.3/implementation-planning/2026-06-23-product-delivery-closure/evidence/EXEC-003-conversation-import-closure.md)
