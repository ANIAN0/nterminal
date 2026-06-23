---
type: Project Code
title: server/errors.mjs
description: 统一生成来源同步错误的稳定错误码、安全文案、retryable 和 contextId。
source_path: server/errors.mjs
tags: [errors, diagnostics, sources]
timestamp: 2026-06-23T18:05:00+08:00
---

# server/errors.mjs

## 能力与边界

该模块把底层文件系统、SQLite、锁和解析异常映射为稳定的来源错误信封 `{code,message,retryable,contextId}`。UI 和同步 API 只应展示这里产出的安全文案，不展示原始路径、SQL、堆栈或底层异常全文。

## 强关联

- `server/conversation-import.mjs` 使用 `mapSourceError` 生成同步失败结果。
- `test/backend/unit/error-contract.test.mjs` 覆盖 missing、permission、schema、locked、disk-full 和正文脱敏。

## 修改风险

新增错误码时必须同步测试错误矩阵，避免破坏设置页重试判断和 T-008 诊断契约。

# Citations

- [源码](../../../server/errors.mjs)
