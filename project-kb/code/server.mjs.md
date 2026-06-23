---
type: Project Code
title: server.mjs
description: 适配 Next.js、自定义 HTTP API、健康检查、诊断日志和 PTY WebSocket 的单进程入口。
source_path: server.mjs
tags: [server, http, websocket, health, logging]
timestamp: 2026-06-23T18:05:00+08:00
---

# server.mjs

## 能力与边界

服务入口负责初始化数据库、工作区服务、导入引擎、PTY 清理器和 Next.js request handler。T-008 后新增 `GET /api/health`，返回核心 ready/not_ready 状态；诊断日志通过 `server/logger.mjs` 写入，只传结构化元数据，不传用户输入、终端输出 preview、URL、cwd、dbPath 或原始错误正文。

## 强关联

- `server/health-service.mjs` 提供 health payload。
- `server/logger.mjs` 提供日志隐私边界。
- `server/conversation-import.mjs` 提供来源同步 API 的结构化结果。
- `server/pty-manager.mjs` 提供 active session 状态。

## 验证建议

修改路由、日志或 health 时运行 `npm test`、`npm run lint`、`npm run build`，并至少覆盖 `health.test.mjs`、`health-http.test.mjs`、`log-privacy.test.mjs`。

# Citations

- [源码](../../server.mjs)
