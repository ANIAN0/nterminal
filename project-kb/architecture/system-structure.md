---
type: Project Architecture
title: nterminal 系统结构
description: 说明当前应用入口、前后端边界、PTY 运行态和 SQLite 持久化职责。
tags: [nextjs, node, pty, sqlite]
timestamp: 2026-06-23T00:00:00+08:00
---

# nterminal 系统结构

## 边界与职责

- `app/` 是 Next.js App Router 前端，页面通过 `app/lib/api.ts` 调用 HTTP API，并通过 WebSocket 连接 PTY。
- `server.mjs` 同时承载 Next.js、自定义 HTTP API 和 PTY WebSocket；`server/` 保存数据库、导入、解析、校验和 PTY 管理模块。
- `server/pty-manager.mjs` 持有仅在当前 Node 进程内有效的 PTY 运行态；SQLite 保存工作区、标签元数据和导入历史，不恢复服务重启前的 PTY 进程。
- `data/`、`logs/` 是运行数据，不属于版本控制或自动测试 fixture。

## 修改风险

- 页面卸载、WebSocket 断开、标签关闭和 PTY 自然退出是不同生命周期事件，不能共享无条件 kill 行为。
- 对话来源可能被其他进程持续写入，读取必须保持源库只读并采用一致快照。
- HTTP、WebSocket、数据库和 React 状态是跨模块契约，修改时必须运行对应集成测试，不能仅依赖构建。

# Citations

- [服务入口](../../server.mjs)
- [前端入口](../../app/page.tsx)
- [已确认技术方案](../../workplace/1.3/tech-design/2026-06-23-product-delivery-closure-tech-design.md)
