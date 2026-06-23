---
type: Project Code
title: server/health-service.mjs
description: 生成 /api/health 的 ready/not_ready 状态，隔离核心健康与来源同步错误。
source_path: server/health-service.mjs
tags: [health, diagnostics, api]
timestamp: 2026-06-23T18:05:00+08:00
---

# server/health-service.mjs

## 能力与边界

`getHealthStatus` 检查数据库 schema 与 PTY 管理器是否可用。核心依赖可用时返回 200 ready；核心检查失败时返回 503 not_ready。对话来源错误只进入 `sourceSummary`，不会让核心 health degraded。

## 强关联

- `server.mjs` 的 `GET /api/health` 路由直接使用该结果。
- `test/backend/integration/health.test.mjs` 覆盖 200/503 和来源错误解耦。
- `test/backend/integration/health-http.test.mjs` 启动真实服务进程验证 HTTP health ready payload。

## 修改风险

不要把单个来源同步错误计入核心 readiness；发布探针应依赖核心 health，而设置页负责展示来源级错误。

# Citations

- [源码](../../../server/health-service.mjs)
