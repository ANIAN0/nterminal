---
type: Project Code
title: app/components/HistoryDetailPage.tsx
description: 展示会话级历史详情、完整消息顺序和工具元数据。
source_path: app/components/HistoryDetailPage.tsx
tags: [history, ui]
timestamp: 2026-06-23T00:00:00+08:00
---

# app/components/HistoryDetailPage.tsx

详情页调用 `/api/history/session`，以 `sourceId + sessionKey` 加载完整会话。页面展示来源、目录、原生会话 ID、消息顺序、工具调用、工具 ID 和消息元数据。

## 边界

- 不提供单消息删除；历史删除语义必须另行设计为会话/来源级操作。
- 消息展示顺序依赖后端 `messageIndex`，前端不重新排序。

# Citations

- [源码](../../../../app/components/HistoryDetailPage.tsx)
