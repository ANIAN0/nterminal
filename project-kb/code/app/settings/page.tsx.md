---
type: Project Code
title: app/settings/page.tsx
description: 展示和管理本地对话来源、逐来源同步、同步全部、错误状态和重试交互。
source_path: app/settings/page.tsx
tags: [settings, sources, ui, diagnostics]
timestamp: 2026-06-23T18:05:00+08:00
---

# app/settings/page.tsx

## 能力与边界

设置页展示每个对话来源的 agent 类型、标签、路径、记录数、最后成功时间、状态、错误码和安全错误摘要。来源同步使用逐来源 pending，同一来源重复点击只发一次请求；同步全部会触发每个来源并汇总成功/失败，不因单来源失败阻断其他来源。

该页面不使用浏览器 `alert`/`confirm`，删除采用应用内二次点击确认。catch 分支只展示稳定安全文案；具体来源错误来自后端结构化字段。

## 强关联

- `app/lib/api.ts` 提供来源增删查同步 API。
- `app/lib/types.ts` 定义来源状态和错误字段。
- `server/conversation-import.mjs` 与 `server/errors.mjs` 提供结构化错误。
- `test/frontend/component/settings-page.test.tsx` 覆盖状态展示、重试、重复点击和同步全部。

## 修改风险

不要把全局 pending 施加到所有来源按钮；不要把原始异常 message 直接显示给用户；新增文案或结构字段时同步组件测试。

# Citations

- [源码](../../../../app/settings/page.tsx)
