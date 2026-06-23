---
type: Project Code
title: vitest.config.mjs
description: 收集根 test 目录的正式单元、集成和组件测试。
source_path: vitest.config.mjs
tags: [vitest, testing]
timestamp: 2026-06-23T00:00:00+08:00
---

# vitest.config.mjs

## 功能与职责

只收集 `test/` 下的 `test/spec` 文件；默认 Node 环境，使用 DOM 的组件测试在文件中显式声明 jsdom。

## 修改注意事项

不得重新引入 `workplace/1.1`、`workplace/1.2` 或 archive；新增目录必须先成为正式根测试资产。修改后运行 `npm test` 和测试清单检查。

# Citations

- [源码](../../vitest.config.mjs)
