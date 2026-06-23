---
type: Project Code
title: server/opencode-sync-worker.mjs
description: 在 worker 线程完成 OpenCode 一致快照、解析和目标库原子替换。
source_path: server/opencode-sync-worker.mjs
tags: [opencode, worker, sqlite]
timestamp: 2026-06-23T00:00:00+08:00
---

# server/opencode-sync-worker.mjs

把真实 OpenCode 的 online backup、single JOIN 解析和数万条 FTS 事务写入移出 HTTP 主线程。worker 只回传统计，不传对话正文；目标库使用 WAL，主线程可继续服务读取请求。

修改时必须验证 revision skip、schema 错误、快照清理、事件循环心跳和真实来源 HTTP 响应延迟。

# Citations

- [源码](../../../server/opencode-sync-worker.mjs)
- [OpenCode 调研](../../../workplace/1.3/tech-design/2026-06-23-product-delivery-closure-tech-design/research/RT-001-opencode-consistent-read.md)
