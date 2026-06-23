---
type: Project Code
title: server/parsers/opencode-parser.mjs
description: 从 OpenCode SQLite 数据库读取 message/part 并映射为统一消息。
source_path: server/parsers/opencode-parser.mjs
tags: [opencode, parser, sqlite]
timestamp: 2026-06-23T00:00:00+08:00
---

# server/parsers/opencode-parser.mjs

## 功能与职责

以只读 better-sqlite3 连接解析 OpenCode message/part 数据。当前实现逐消息查询 part；1.3 导入任务将改为一致快照和单 JOIN 会话契约。

## 修改风险与验证

真实 OpenCode 可能并发写 WAL；不能直接修改源库，也不能把真实对话作为 fixture。修改时必须验证锁竞争、目录归属、消息顺序和连接清理。

# Citations

- [源码](../../../../server/parsers/opencode-parser.mjs)
