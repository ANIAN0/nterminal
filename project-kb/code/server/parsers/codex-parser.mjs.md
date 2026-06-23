---
type: Project Code
title: server/parsers/codex-parser.mjs
description: 解析 Codex session_meta、response_item 和 event_msg。
source_path: server/parsers/codex-parser.mjs
tags: [parser, codex]
timestamp: 2026-06-23T00:00:00+08:00
---

# server/parsers/codex-parser.mjs

优先使用 response_item 并对 event_msg 去重；session_meta 元数据可能位于 payload，修改时必须验证原生会话 ID、cwd 和时间。

# Citations

- [源码](../../../../server/parsers/codex-parser.mjs)
