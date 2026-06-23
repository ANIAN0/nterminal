---
type: Project Code
title: app/lib/terminal-protocol.ts
description: 浏览器端终端输出帧解析和 resize 控制帧编码。
source_path: app/lib/terminal-protocol.ts
tags: [terminal, websocket, protocol]
timestamp: 2026-06-23T12:25:00+08:00
---

# app/lib/terminal-protocol.ts

负责解析服务端二进制输出帧、编码 `v:1` resize 控制帧，并解析 JSON envelope。该文件必须与 [server/terminal-protocol.mjs](../../server/terminal-protocol.mjs.md) 保持版本和帧格式一致。

# Citations

- [源码](../../../../app/lib/terminal-protocol.ts)
