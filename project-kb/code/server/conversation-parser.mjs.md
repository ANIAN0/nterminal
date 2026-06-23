---
type: Project Code
title: server/conversation-parser.mjs
description: 检测四类来源格式并分发统一会话级解析。
source_path: server/conversation-parser.mjs
tags: [parser, registry]
timestamp: 2026-06-23T00:00:00+08:00
---

# server/conversation-parser.mjs

## 功能与职责

检测 Claude、Codex、Pi JSONL 和 OpenCode SQLite，维护 parser 注册表。1.3 的正式入口返回会话数组；旧消息级入口仅为当前兼容调用保留。

## 修改风险与验证

格式检测不能吞掉可识别文件的结构错误；未知 role 必须返回结构化错误。修改时运行四来源 parser contract 测试。

# Citations

- [源码](../../../server/conversation-parser.mjs)
