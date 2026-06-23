---
type: Project Code
title: app/lib/api.ts
description: 封装浏览器到 nterminal HTTP API 的请求、取消和统一错误。
source_path: app/lib/api.ts
tags: [frontend, api]
timestamp: 2026-06-23T00:00:00+08:00
---

# app/lib/api.ts

API 客户端解包 `{ok,data}` 并把后端错误转为 ApiError；操作级 AbortSignal 必须透传。历史查询只保留会话级 `/api/history/sessions` 和 `/api/history/session`，不得恢复 `/api/records/*` 单消息入口。

# Citations

- [源码](../../../../app/lib/api.ts)
