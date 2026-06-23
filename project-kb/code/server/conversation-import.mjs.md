---
type: Project Code
title: server/conversation-import.mjs
description: 扫描对话来源并把解析结果同步到 nterminal 数据库。
source_path: server/conversation-import.mjs
tags: [import, history, sqlite, diagnostics]
timestamp: 2026-06-23T18:05:00+08:00
---

# server/conversation-import.mjs

## 能力与边界

该模块按来源执行同步调度、source mutex、状态更新、定时同步和目录监听。JSONL 与 OpenCode 大量解析写入由 worker 隔离，主线程保持 HTTP 可响应。

T-008 后，同步失败会通过 `server/errors.mjs` 映射为 `{code,message,retryable,contextId}`，并写回 `conversation_sources` 的最后错误字段。单来源失败不能阻断其他来源同步，也不能影响核心 `/api/health`。

## 强关联

- `server/database.mjs` 持久化来源状态、错误和会话消息。
- `server/errors.mjs` 提供稳定错误码与安全文案。
- `app/settings/page.tsx` 消费来源状态、错误码和重试语义。

## 验证建议

修改来源同步和错误处理时运行 source-errors、opencode-snapshot、settings-page、health 和 log-privacy 相关测试。

# Citations

- [源码](../../../server/conversation-import.mjs)
