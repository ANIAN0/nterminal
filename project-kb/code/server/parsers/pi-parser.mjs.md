---
type: Project Code
title: server/parsers/pi-parser.mjs
description: 解析 Pi v3 会话 header 和后续消息事件。
source_path: server/parsers/pi-parser.mjs
tags: [parser, pi]
timestamp: 2026-06-23T00:00:00+08:00
---

# server/parsers/pi-parser.mjs

首行 session header 提供 id、cwd、timestamp，后续 message/custom_message 形成有序消息；压缩与分支摘要不作为消息。

# Citations

- [源码](../../../../server/parsers/pi-parser.mjs)
