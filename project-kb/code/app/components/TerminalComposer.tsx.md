---
type: Project Code
title: app/components/TerminalComposer.tsx
description: 终端命令模式输入器，负责本地草稿、IME 防误提交和补全选择。
source_path: app/components/TerminalComposer.tsx
tags: [terminal, input, composer]
timestamp: 2026-06-23T12:35:00+08:00
---

# app/components/TerminalComposer.tsx

该组件把命令模式输入从 wterm 隐藏 textarea 中拆出：用户编辑本地草稿，按 Enter 时只发送一次 `text + "\r"` 并立即清空；IME composition 期间 Enter 不提交；补全项只填入草稿，不直接发送命令。

后续接入 `TerminalWorkspace` 时必须保持 direct 模式与 wterm `onData` 互斥，避免同一按键既进入 composer 又传给 PTY。

# Citations

- [源码](../../../../app/components/TerminalComposer.tsx)
- [组件测试](../../../../test/frontend/component/terminal-composer.test.tsx)
