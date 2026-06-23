---
type: Project Code
title: server/workspace-service.mjs
description: 管理工作区和标签的幂等创建、关闭和删除。
source_path: server/workspace-service.mjs
tags: [workspace, tabs, idempotency]
timestamp: 2026-06-23T00:00:00+08:00
---

# server/workspace-service.mjs

工作区以真实规范目录唯一，标签以 create_request_id 幂等；PTY 创建/关闭通过注入边界调用。活动标签删除返回 409，显式 close 后才能删除，数据库写失败必须回收新 PTY。

# Citations

- [源码](../../../server/workspace-service.mjs)
