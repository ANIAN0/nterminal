---
type: Project Code
title: app/components/HistoryPage.tsx
description: 展示按来源、工作区和会话分组的历史列表与搜索入口。
source_path: app/components/HistoryPage.tsx
tags: [frontend, history]
timestamp: 2026-06-23T00:00:00+08:00
---

# app/components/HistoryPage.tsx

## 功能与职责

历史列表页调用 `/api/history/sessions`，展示来源错误、来源分组、工作区目录和会话卡片。会话卡片进入 `/history/detail?sourceId=&sessionKey=`，不再链接单条消息记录。

## 关键逻辑与边界

- 搜索提交只刷新会话级列表，不在客户端全量消息扫描或重组。
- `sourceStates` 中的错误来源以 partial 状态提示，但不隐藏其他已导入历史。
- 会话链接必须同时带 `sourceId` 和 `sessionKey`，与后端详情边界一致。

## 测试与验证

- `test/frontend/component/history-page.test.tsx` 覆盖分组三层、partial 来源错误和会话级搜索 API。
- `test/e2e/history.spec.ts` 覆盖真实页面搜索和进入详情。

# Citations

- [源码](../../../../app/components/HistoryPage.tsx)
