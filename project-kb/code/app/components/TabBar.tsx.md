---
type: Project Code
title: app/components/TabBar.tsx
description: 终端标签栏展示、切换、新建和关闭按钮组件。
source_path: app/components/TabBar.tsx
tags: [terminal, tabs, frontend]
timestamp: 2026-06-23T22:10:00+08:00
---

# app/components/TabBar.tsx

标签栏只负责展示和分发标签交互，实际关闭、新建和 PTY 生命周期由 `TerminalWorkspace` 与服务端工作区服务处理。新建按钮受 `MAX_TABS` 限制，关闭按钮提供可访问的中文 aria-label。

修改时需验证关闭最后标签返回首页、新建标签按钮不是摆设、标签状态颜色仍正确。

# Citations

- [源码](../../../../app/components/TabBar.tsx)
