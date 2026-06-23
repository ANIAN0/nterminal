---
type: Project Code
title: server/history-service.mjs
description: 提供会话级历史列表、搜索分组、来源状态和详情查询服务。
source_path: server/history-service.mjs
tags: [history, sqlite, search]
timestamp: 2026-06-23T00:00:00+08:00
---

# server/history-service.mjs

## 功能与职责

从 `conversation_sessions`、`conversations` 和 `conversation_sources` 生成历史页唯一事实源。列表按来源 → 工作区/目录 → 会话分组，详情按 `message_index` 返回完整消息和工具元数据。

## 关键逻辑与边界

- `listHistorySessions` 只返回会话列表，不暴露单消息删除或单消息详情。
- 查询为 `*` 时按会话时间列出；1-2 字符走有界 `LIKE ESCAPE`；3 字符及以上走 FTS5 trigram `MATCH`。
- `sourceStates` 总是返回全部来源状态，错误来源不阻断既有历史读取。
- 会话没有 `cwd` 时使用来源路径作为工作区分组，避免历史页出现空目录。
- `getHistorySession` 必须同时校验 `sourceId` 和 `sessionKey`，防止跨来源 session key 混淆。

## 测试与验证

- `test/backend/integration/history-api.test.mjs` 覆盖分组、partial 来源状态、详情元数据和缺失会话错误。
- `test/backend/integration/history-session-search.test.mjs` 覆盖 LIKE/FTS 选路、分页和特殊字符搜索。
- `test/e2e/history.spec.ts` 覆盖真实浏览器历史列表到详情主流程和旧 records API 404。

# Citations

- [源码](../../../server/history-service.mjs)
