---
type: Project Code
title: server/startup-discovery.mjs
description: 发现四类本地 Agent 默认来源并幂等写入来源配置。
source_path: server/startup-discovery.mjs
tags: [startup, sources]
timestamp: 2026-06-23T00:00:00+08:00
---

# server/startup-discovery.mjs

## 功能与职责

检查 Claude、Pi、Codex 和 OpenCode 的默认路径，并在来源表没有对应 agent 类型时创建默认配置。不得修改外部来源内容。

## 修改风险与验证

路径可能不存在或包含中文；发现失败不能阻止核心数据库启动。修改时验证重复调用不新增重复来源。

# Citations

- [源码](../../../server/startup-discovery.mjs)
