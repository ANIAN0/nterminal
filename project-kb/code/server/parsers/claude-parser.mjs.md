---
type: Project Code
title: server/parsers/claude-parser.mjs
description: 解析 Claude history 和会话 JSONL。
source_path: server/parsers/claude-parser.mjs
tags: [parser, claude]
timestamp: 2026-06-23T00:00:00+08:00
---

# server/parsers/claude-parser.mjs

提取 Claude 用户、助手和工具消息；会话契约还需保留 sessionId、cwd、来源文件和有序消息。修改后运行 parser contract 与旧 history 回归。

# Citations

- [源码](../../../../server/parsers/claude-parser.mjs)
