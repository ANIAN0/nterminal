---
type: Project Code
title: app/lib/types.ts
description: 前端共享类型，覆盖工作区、终端、历史和对话来源状态。
source_path: app/lib/types.ts
tags: [frontend, types, api]
timestamp: 2026-06-23T18:05:00+08:00
---

# app/lib/types.ts

## 能力与边界

该文件定义前端 API 数据结构。T-008 后 `ConversationSource` 包含 `lastSuccessAt`、`lastErrorCode`、`lastErrorMessage`、`lastErrorAt` 和 `syncState`，用于设置页逐来源展示成功/失败状态；`SyncResult` 应承载同步结果和结构化错误。

## 强关联

- `app/settings/page.tsx` 读取来源状态和错误摘要。
- `app/lib/api.ts` 负责把后端 JSON 响应映射到这些类型。
- `server/conversation-import.mjs` 和 `server/database.mjs` 提供这些字段。

## 修改风险

字段改名会影响设置页、历史页和组件测试。新增来源错误字段时需同步后端响应与组件断言。

# Citations

- [源码](../../../../app/lib/types.ts)
