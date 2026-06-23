---
type: Project Code
title: app/components/useTerminalInputMode.ts
description: 维护每个终端标签的 command/direct 输入模式覆盖。
source_path: app/components/useTerminalInputMode.ts
tags: [terminal, input, hook]
timestamp: 2026-06-23T13:00:00+08:00
---

# app/components/useTerminalInputMode.ts

该 hook 以 tabId 为 key 在 `sessionStorage` 中保存输入模式。默认 `command`；用户手动切换后，同一标签重新挂载时恢复为上次模式。模式只影响浏览器端输入路径，不修改 PTY 协议。

# Citations

- [源码](../../../../app/components/useTerminalInputMode.ts)
- [终端页集成测试](../../../../test/frontend/integration/terminal-workspace.test.tsx)
