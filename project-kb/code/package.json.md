---
type: Project Code
title: package.json
description: 定义 nterminal 依赖与正式开发、测试、静态检查和构建入口。
source_path: package.json
tags: [tooling, scripts]
timestamp: 2026-06-23T00:00:00+08:00
---

# package.json

## 功能与职责

维护 Next.js/React、Node PTY、WebSocket、SQLite 以及测试工具依赖；脚本必须只引用根正式测试，不引用历史 workplace。

## 关联与测试

- [Vitest 配置](vitest.config.mjs.md) 决定 `npm test` 的收集范围。
- [ESLint 配置](eslint.config.mjs.md) 决定 `npm run lint` 的检查范围。
- 修改后运行 `npm test`、`npm run lint`、`npm run build`，依赖变化还需保持 `package-lock.json` 一致。

## 修改注意事项

工作树中的依赖改动可能属于其他任务，修改 scripts 时不得覆盖；移除数据库驱动由数据库迁移任务负责。

# Citations

- [源码](../../package.json)
