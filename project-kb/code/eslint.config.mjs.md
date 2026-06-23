---
type: Project Code
title: eslint.config.mjs
description: 定义当前生产源码和正式测试的静态检查范围。
source_path: eslint.config.mjs
tags: [eslint, quality]
timestamp: 2026-06-23T00:00:00+08:00
---

# eslint.config.mjs

## 功能与职责

继承 Next.js Core Web Vitals 与 TypeScript 规则，并排除构建产物、运行数据、研发文档和历史归档。

## 修改注意事项

排除范围只能隔离非生产资产，不能通过忽略 `app/`、`server/`、根配置或 `test/` 隐藏当前错误。修改后运行 `npm run lint`。

# Citations

- [源码](../../eslint.config.mjs)
