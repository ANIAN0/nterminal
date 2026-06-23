---
type: Project Code
title: app/lib/terminal-connection.ts
description: 浏览器端终端连接状态、视图绑定和 WebSocket URL 契约。
source_path: app/lib/terminal-connection.ts
tags: [terminal, websocket, frontend]
timestamp: 2026-06-23T12:25:00+08:00
---

# app/lib/terminal-connection.ts

定义终端连接状态和视图绑定接口，并用 tabId 与 lastOffset 构造 `/ws/pty/:tabId?lastOffset=` URL。该文件是 provider 与终端视图之间的轻量契约层。

# Citations

- [源码](../../../../app/lib/terminal-connection.ts)
