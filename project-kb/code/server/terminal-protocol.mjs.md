---
type: Project Code
title: server/terminal-protocol.mjs
description: 服务端终端协议 envelope 和 offset 输出帧编解码。
source_path: server/terminal-protocol.mjs
tags: [terminal, websocket, protocol]
timestamp: 2026-06-23T12:25:00+08:00
---

# server/terminal-protocol.mjs

输出帧格式为 `0x01 + uint64BE(startOffset) + payload`。JSON envelope 带 `v:1`，用于 hello、session_state、error 和 resize 控制。修改时必须同步浏览器端 [app/lib/terminal-protocol.ts](../app/lib/terminal-protocol.ts.md)。

# Citations

- [源码](../../../server/terminal-protocol.mjs)
