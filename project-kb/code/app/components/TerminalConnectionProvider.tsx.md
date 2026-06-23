---
type: Project Code
title: app/components/TerminalConnectionProvider.tsx
description: 在应用框架内保持终端 WebSocket 跨页面常驻。
source_path: app/components/TerminalConnectionProvider.tsx
tags: [terminal, websocket, provider]
timestamp: 2026-06-23T12:25:00+08:00
---

# app/components/TerminalConnectionProvider.tsx

## 功能与职责

该 provider 按 tabId 管理浏览器 WebSocket 连接、lastOffset、视图绑定和输出 backlog。终端页面卸载只解绑当前 wterm 视图，不关闭 socket；重新进入同一 tab 复用连接并回放 backlog。

PTY 输出先进入 per-connection pending 队列，并在 `requestAnimationFrame` 中合并写入视图，原因是持续输出不能触发每帧多次 React/DOM 写入。

## 修改风险与验证

修改时运行 `test/frontend/integration/terminal-connection-provider.test.tsx`，并用真实 WS smoke 验证断开重连、主动关闭、hello/snapshot 和输出批处理。

# Citations

- [源码](../../../../app/components/TerminalConnectionProvider.tsx)
