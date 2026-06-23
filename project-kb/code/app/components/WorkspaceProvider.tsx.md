---
type: Project Code
title: app/components/WorkspaceProvider.tsx
description: 工作区列表加载、创建工作区、防重复点击和局部错误状态 provider。
source_path: app/components/WorkspaceProvider.tsx
tags: [workspace, frontend, state]
timestamp: 2026-06-23T22:10:00+08:00
---

# app/components/WorkspaceProvider.tsx

该 provider 维护工作区列表、创建工作区 pending 状态和局部错误。创建动作使用 ref + state 双层 pending：ref 在同一事件循环内立即生效，防止 React 状态提交前的重复点击穿透；state 用于 UI 禁用按钮。

错误提示使用稳定安全文案，例如“加载工作区失败”“创建工作区失败”，不透传后端原始 message。修改时需运行 `test/frontend/component/workspace-actions.test.tsx`。

# Citations

- [源码](../../../../app/components/WorkspaceProvider.tsx)
- [组件测试](../../../../test/frontend/component/workspace-actions.test.tsx)
