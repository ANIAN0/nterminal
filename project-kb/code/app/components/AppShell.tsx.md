---
type: Project Code
title: app/components/AppShell.tsx
description: 全局应用壳，挂载工作区 provider、终端连接 provider 和左侧导航。
source_path: app/components/AppShell.tsx
tags: [layout, workspace, terminal]
timestamp: 2026-06-23T22:10:00+08:00
---

# app/components/AppShell.tsx

应用壳负责在所有主页面显示工作区侧栏，并挂载 `WorkspaceProvider` 与 `TerminalConnectionProvider`。侧栏提供概览、历史、设置入口，并展示已注册工作区。

终端页必须仍显示该侧栏，避免用户进入终端后失去工作区上下文。

# Citations

- [源码](../../../../app/components/AppShell.tsx)
