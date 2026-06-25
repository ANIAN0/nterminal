---
type: Project Code
title: package.json
description: 定义 nterminal 依赖与正式开发、静态检查和构建入口；测试入口已迁移至 workplace 下 pytest+uv 体系。
source_path: package.json
tags: [tooling, scripts]
timestamp: 2026-06-25T00:00:00+08:00
---

# package.json

## 功能与职责

维护 Next.js/React、Node PTY、WebSocket、SQLite 等生产依赖与 lint/build 入口；不再包含任何测试运行器（Vitest/Playwright）依赖或脚本。测试按 `AGENTS.md` 第 12 条统一在 `workplace/<version>/...` 下用 pytest + uv 独立 venv 执行。

## 关联与测试

- [ESLint 配置](eslint.config.mjs.md) 决定 `npm run lint` 的检查范围。
- 修改后运行 `npm run lint`、`npm run build`，依赖变化还需保持 `package-lock.json` 一致。
- pytest 用例不在此处触发，对应 `workplace/<version>/` 下用 `uv run pytest` 启动。

## 修改注意事项

工作树中的依赖改动可能属于其他任务，修改 scripts 时不得覆盖；移除数据库驱动由数据库迁移任务负责。**禁止在 scripts 中重新引入测试运行器**，所有测试统一迁移到 workplace 下用 pytest 维护。

# Citations

- [源码](../../package.json)
