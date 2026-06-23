---
type: Project Code
title: server/logger.mjs
description: 诊断日志写入器，采用字段 allowlist 避免泄露命令、请求正文、对话正文、路径和堆栈。
source_path: server/logger.mjs
tags: [logging, privacy, diagnostics]
timestamp: 2026-06-23T18:05:00+08:00
---

# server/logger.mjs

## 能力与边界

`createLogger` 写入 JSON line 诊断日志，并只保留 allowlist 字段。允许记录 `contextId`、错误码、source/session/tab/workspace 标识和传输大小；不允许记录 command、body、text、input、preview、URL、cwd、dbPath 或原始错误 message。

## 强关联

- `server.mjs` 通过该模块记录 HTTP、WebSocket、PTY 和导入事件。
- `test/backend/integration/log-privacy.test.mjs` 用 canary 验证敏感字段不会落盘。

## 修改风险

扩大 allowlist 前必须确认字段不会包含用户命令、对话正文、本地路径、SQL 或堆栈。

# Citations

- [源码](../../../server/logger.mjs)
