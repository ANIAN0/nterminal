---
type: Project Code
title: app/components/HomePage.tsx
description: 工作区概览页，提供添加工作区后的进入终端入口。
source_path: app/components/HomePage.tsx
tags: [home, workspace, frontend]
timestamp: 2026-06-23T22:10:00+08:00
---

# app/components/HomePage.tsx

首页展示工作区概览、活动标签数量和添加工作区表单。打开工作区时先通过 API 创建/复用标签，再跳转到 `/terminal?workspace=...&tab=...`，避免终端页缺少 tab 导致空壳。

用户可见文案应保持可读中文，工作区打开期间使用局部 opening 状态防重复点击。

# Citations

- [源码](../../../../app/components/HomePage.tsx)
