---
type: Project Code
title: server/validation.mjs
description: 校验 cwd、路径、查询和有界请求体。
source_path: server/validation.mjs
tags: [validation, security]
timestamp: 2026-06-23T00:00:00+08:00
---

# server/validation.mjs

路径校验必须支持 Windows 中文绝对路径并拒绝空值、过长值和不存在目录；HTTP 与服务层都不能依赖前端校验。

# Citations

- [源码](../../../server/validation.mjs)
