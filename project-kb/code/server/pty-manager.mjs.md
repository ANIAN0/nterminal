---
type: Project Code
title: server/pty-manager.mjs
description: 管理 PTY 进程、连接集合、断线宽限、自然退出和输出 ring。
source_path: server/pty-manager.mjs
tags: [pty, websocket, lifecycle]
timestamp: 2026-06-23T12:25:00+08:00
---

# server/pty-manager.mjs

## 功能与职责

该文件是 PTY 运行时唯一事实源：创建 shell、保存运行状态、维护连接 listener Set、在最后连接断开后启动五分钟宽限计时，并在主动关闭或宽限到期时终止进程。

## 关键逻辑与边界

- 输入时间不再作为存活依据，原因是空闲连接也应长期保持。
- `addSessionListener/removeSessionListener` 分别表示连接 attach/detach；detach 只启动宽限，不直接 kill。
- 自然退出保留 ended 状态供只读显示；主动关闭和宽限回收会移除运行态。
- 每个 session 维护单调字节 offset 与服务端输出 ring，供 WebSocket 重连 snapshot 使用。

## 强关联文件

- [server.mjs](../server.mjs.md)：WebSocket 只做协议适配，关闭 socket 时调用 detach。
- [server/terminal-protocol.mjs](terminal-protocol.mjs.md)：编码输出帧和状态 envelope。
- [server/workspace-service.mjs](workspace-service.mjs.md)：主动关闭标签时调用 `killSession`。

## 测试与验证

- `test/backend/unit/pty-manager.test.mjs` 覆盖空闲十分钟、断线宽限、宽限内重连、主动关闭和自然退出。
- `test/backend/integration/terminal-websocket.test.mjs` 覆盖 offset snapshot、live 连续和 OUTPUT_GAP。

# Citations

- [源码](../../../server/pty-manager.mjs)
- [T-005 任务](../../../workplace/1.3/implementation-planning/2026-06-23-product-delivery-closure/tasks/T-005-pty-lifecycle-and-protocol.md)
