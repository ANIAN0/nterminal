---
type: Project Code
title: app/components/TerminalWorkspace.tsx
description: 终端标签视图、wterm 绑定、固定输入框、补全、状态联动和最后标签关闭行为。
source_path: app/components/TerminalWorkspace.tsx
tags: [terminal, workspace, frontend]
timestamp: 2026-06-23T22:10:00+08:00
---

# app/components/TerminalWorkspace.tsx

终端页面通过 [TerminalConnectionProvider.tsx](TerminalConnectionProvider.tsx.md) 绑定当前 tab 视图；页面切换或组件卸载只解绑输出消费者，socket 生命周期由根 provider 和服务端 PTY manager 决定。

该组件保留终端视图、标签、状态条和底部 composer：命令模式输入由 [TerminalComposer.tsx](TerminalComposer.tsx.md) 管理，wterm `onData` 在 command 模式不转发，direct 模式才把 wterm bytes 原样传给 provider。关闭最后一个活动标签后会返回首页，避免终端页留下无会话空壳。

用户可见文案必须保持可读中文，错误提示使用稳定安全文案，不直接展示底层异常 message。修改时需验证组件/集成测试、真实 Edge E2E 和性能 spec，避免重新引入双输入源、双建议面板或关闭标签不联动。

# Citations

- [源码](../../../../app/components/TerminalWorkspace.tsx)
- [集成测试](../../../../test/frontend/integration/terminal-workspace.test.tsx)
- [发布 E2E](../../../../test/e2e/failure-recovery.spec.ts)
