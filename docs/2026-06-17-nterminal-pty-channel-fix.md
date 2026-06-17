# nterminal 终端通道修复 需求简报

## 审查摘要
| 项 | 结论 |
|----|------|
| 要做的功能 | 修复 nterminal 终端页三个交互缺陷：进入终端顶部出现 JSON 首行、TUI 乱行/字符混在一起、codingagent 输出重复延伸；并保证修复后兼容 pi TUI 场景下的用户消息与 agent 回复识别 |
| 呈现形态 | 服务端 `server.mjs` PTY WebSocket 通道 + 客户端 `TerminalWorkspace.tsx` 消息处理；新增 OSC 133 语义解析层 |
| 目标结果 | 进入终端不再出现 JSON 噪声；vim/pi 等 TUI 正常差分渲染不乱行；agent 输出不再重复延伸；pi 的用户消息/agent 回复能被正确识别并写入右侧记录面板 |
| 现状证据 | 已确认 wterm 官方契约（`examples/local/server.ts`）为单通道纯字节 + ANSI 伪装 resize，无 JSON 控制帧；nterminal 当前 `bindPtyWebSocket` 在同一 WS 发送 `ready`/`user_message`/`agent_reply`/`session_exit` JSON 帧，前端 `onmessage` 无条件 `write()` 所有字符串；已确认 pi-tui（`packages/tui/src/terminal.ts:147`）启用 bracketed paste 但不启用 alt-screen，采用差分渲染；pi 的 `user-message.ts`/`assistant-message.ts` 用 OSC 133（`\x1b]133;A/B/C\x07`）标注 user/assistant 语义边界；nterminal `stripAnsi`（`text-utils.mjs:9`）会剥掉 OSC 序列 |
| 本期范围 | R-001 PTY WS 通道退回纯字节契约；R-002 客户端 onmessage 严格只 write 字节；R-003 JSON 控制帧移出 PTY 通道（记录/搜索走 HTTP）；R-004 新增 OSC 133 语义解析器；R-005 observer 用 OSC 边界替代空闲计时识别 user/assistant；R-006 stripAnsi 保留 OSC 边界；R-007 TUI 输入识别降级 |
| 不做范围 | 独立 `/ws/records` 实时推送通道（后续候选）、右侧面板 UI 重构、pi SDK 进程内集成、多 session 并发隔离、记录全文搜索增强、主题/暗色模式 |
| 关键决策 | DECIDE-001 PTY WS 退回 wterm 官方纯字节契约（已确认）；DECIDE-002 记录/搜索完全走 HTTP 不依赖 WS 推送（已确认）；DECIDE-003 用 OSC 133 解析替代空闲计时识别 pi 的 user/assistant（已确认）；DECIDE-004 检测不到 OSC 时回退现有空闲计时逻辑兼容普通 shell（已确认）；DECIDE-005 pi 场景 user 文本字段诚实降级不塞乱码（已确认）；DECIDE-006 OSC 解析在 stripAnsi 之前执行（已确认） |
| 主要风险/假设 | 假设 wterm 0.3.0 的 WASM 终端核心正确处理差分渲染序列；假设 pi 持续输出 OSC 133 不变更；假设普通 shell（bash/cmd）不发 OSC 133 时回退路径可用；TUI 下用户输入不回显导致 user 文本可能为空 |
| 待用户确认 | 无阻塞级问题；P0 与 P1 是否分两次提交需用户确认节奏 |

## 摘要

nterminal 终端页存在三个交互缺陷，根因是同一条 WebSocket 把"语义记录通道"和"PTY 字节通道"混在一起：服务端在 PTY WS 上发送 JSON 控制帧（`ready`/`user_message`/`agent_reply`/`session_exit`），客户端 `onmessage` 把所有字符串无条件 `write()` 进 wterm 终端核心，导致 JSON 文本被当成可见字符渲染。修复方案分两步：P0 把 PTY WS 退回 wterm 官方的"纯字节 + ANSI 伪装 resize"契约，彻底消除三个缺陷；P1 引入 OSC 133（Semantic Prompts / Shell Integration）语义解析，替代基于空闲时间的 user/assistant 识别，使 pi TUI 的 agent 回复能被正确捕获写入记录。

## 功能概览
| 项 | 内容 |
|----|------|
| 功能名称 | nterminal 终端通道修复 |
| 目标用户/调用方 | 本地开发者，使用 nterminal 终端页操作 shell / TUI（含 pi coding agent） |
| 功能目标 | 终端字节流纯净无 JSON 噪声；TUI 差分渲染正确；agent 输出不重复；pi 的 user/assistant 能被识别记录 |
| 呈现形态 | 服务端 WS + 客户端 React 组件 + 服务端 OSC 解析模块 |
| 主要入口 | `/terminal?sessionId=...` 终端页 |
| 核心操作 | 进入终端、在 shell 或 TUI 中交互、agent 回复被右侧记录面板捕获 |
| 成功结果 | 无 JSON 首行、TUI 不乱行、agent 输出不重复延伸、pi 回复进记录 |
| 失败反馈 | session_exit 用 ANSI 字节提示（非 JSON）；OSC 解析失败时回退空闲计时 |
| 结果可见位置 | 终端主区域渲染、右侧搜索面板记录列表 |

## 现状证据摘要
| 类型 | 已检查位置 | 发现 | 对需求的影响 |
|------|------------|------|--------------|
| 客户端 | `app/components/TerminalWorkspace.tsx:64-79` | `ws.onmessage` 对 `typeof data === 'string'` 无条件 `terminalRef.current?.write(data)`，无任何信封解析 | JSON 帧被渲染为可见文本，是问题1/2/3 的直接原因 |
| 服务端 | `server.mjs:491` | `sendWs(ws, { type:'ready', sessionId })` 在 WS 建连后立即发字符串 JSON | 问题1 的 ready 首行来源 |
| 服务端 | `server.mjs:179-188`（`flushUserMessage`）、`:206-227`（`flushAgentReply`） | 运行中持续 `sendWs(... 'user_message'/'agent_reply')` 把 JSON/归一化文本发回前端 | 问题2/3 的回灌来源；agent_reply 把归一化文本二次 write 导致重复延伸 |
| 客户端 | 全文 `findstr` | 无任何 `JSON.parse`、无 `user_message`/`agent_reply` 消费者；`api.ts` 全走 HTTP POST | JSON 帧在前端是纯死代码副作用，移除零功能损失 |
| 客户端 | `app/components/TerminalWorkspace.tsx:102` | 右侧搜索面板已用 HTTP `/api/records/search` + debounced | 记录/搜索早已独立于 WS 推送 |
| wterm 官方 | `wterm/examples/local/server.ts:45-49` | `ptyProcess.onData((data) => ws.send(data))`，只发 PTY 原始字节 | 确立"纯字节通道"最佳实践基准 |
| wterm 官方 | `wterm/examples/local/app/page.tsx:29-31` | `ws.onmessage = (event) => write(event.data)`，无解析 | 客户端只 write 字节 |
| wterm 官方 | `wterm/examples/local/server.ts:56-74` | resize 用 `\x1b[RESIZE:cols;rows]` ANSI 伪装走同一通道 | 控制信号用 ANSI 而非 JSON |
| pi-tui | `pi-mono/packages/tui/src/terminal.ts:147,485,489` | 启用 bracketed paste (`\x1b[?2004h`)、cursor hide (`\x1b[?25l`)；不启用 alt-screen (`\x1b[?1049h`) | pi 是行内滚动式 TUI，非全屏 alt-screen |
| pi-tui | `pi-mono/packages/tui/src/tui.ts:2,1444-1447` | 差分渲染（differential rendering），输出大量 ANSI 光标定位/擦除序列 | JSON 帧注入会破坏光标重绘基准 = 乱行 |
| pi 源码 | `pi-mono/packages/coding-agent/src/modes/interactive/components/user-message.ts:4-6,38-39` | 用 OSC 133 标注：`\x1b]133;A\x07`...`\x1b]133;B\x07`...`\x1b]133;C\x07` 包裹用户消息 | pi 主动提供语义边界，可解析 |
| pi 源码 | `pi-mono/packages/coding-agent/src/modes/interactive/components/assistant-message.ts:5-7,68-69` | assistant 消息同样用 OSC 133 A/B/C 包裹 | assistant 边界可解析 |
| pi-tui | `pi-mono/packages/tui/src/terminal.ts:134-144` | raw mode + pi-tui 自处理编辑/补全/历史，pi 不把用户输入回显到 stdout | TUI 下 user 文本无法从输出流获取，需降级 |
| nterminal | `server/text-utils.mjs:9-15` | `stripAnsi` 第一正则 `\x1b\][\s\S]*?(?:\x07|\x1b\\)` 剥掉所有 OSC 序列 | OSC133 语义边界被擦除，需在 strip 前解析 |
| nterminal | `server.mjs:140-154`（`observeInput`）、`:190-204`（`observeOutput`）、`:52`（`REPLY_IDLE_MS=1800`） | 逐字符 echo 推断 + 空闲 1.8s 切片，基于行式 shell 假设 | 对 pi 差分渲染流式输出失效，需 OSC 替代 |

## 确认记录
| 闸门 | 确认内容 | 用户结论 | 影响 |
|------|----------|----------|------|
| G1 问题与根因 | 三缺陷根因同源：PTY WS 通道混入 JSON 控制帧，前端无条件 write；wterm 官方契约为纯字节 | 已确认（前序对话） | P0 方向锁定 |
| G2 pi 兼容性 | pi 用差分渲染 + OSC 133 标注边界；nterminal 现有 echo 推断/空闲计时对 pi 失效；OSC 133 是行业协议可解析 | 已确认（前序对话） | P1 方向锁定 |
| G3 范围与节奏 | P0 修三 bug，P1 做 pi 记录识别；是否分两次提交待用户确认 | 待用户确认 | 实施节奏 |

## 需求推导
- 当前问题：终端页 JSON 噪声污染字节流，TUI 乱行，agent 输出重复；pi 场景下 user/assistant 识别逻辑失效
- 不做的后果：终端不可用于 TUI/agent 场景，pi 回复无法进入记录面板，产品核心交互不可用
- 目标用户/角色：本地开发者
- 功能目标：终端字节流纯净；TUI 正确渲染；agent 输出不重复；pi 语义正确捕获
- 核心机制：服务端 PTY WS 只发字节 + ANSI 伪装 resize（对齐 wterm 官方）；客户端只 write 字节；记录/搜索走 HTTP；OSC 133 解析器在服务端消费 PTY 输出流的语义边界，替代空闲计时识别 user/assistant
- 关键约束：不修改 wterm 包本身；不修改 pi 一行代码；纯服务端解析层增强；对普通 shell 向后兼容（OSC 缺失时回退）

## 范围边界
| 分类 | 内容 | 原因 |
|------|------|------|
| 本期范围 | R-001~R-007：WS 纯字节化、客户端只 write 字节、JSON 帧移出通道、OSC 解析器、observer OSC 边界识别、stripAnsi 保留 OSC、TUI 输入降级 | 修缺陷 + pi 兼容闭环 |
| 后续候选 | 独立 `/ws/records` 实时推送通道（若右侧面板需实时刷新而非 debounced 轮询）、右侧面板 UI 重构、pi 进程内 SDK 集成（替代 PTY 启动 pi）、记录全文搜索增强 | 有价值但不影响本期闭环 |
| 不做范围 | 主题/暗色模式、多 session 并发隔离、OSC 133 D（exit code）深度利用、Kitty 键盘协议协商处理、pi 会话 JSONL 双写去重 | 超出本期范围 |

## 核心对象和边界
| 对象 | 含义 | 来源/拥有者 | 生命周期 | 边界 |
|------|------|-------------|----------|------|
| PTY 字节通道 | `/ws/pty/:sessionId` 上的原始 PTY 输入输出字节流 | server.mjs bindPtyWebSocket | WS 连接级 | 只承载字节 + ANSI 伪装 resize，不承载任何 JSON |
| 控制信令 | ready/session_exit/error 等 | server.mjs | WS 连接级 | 移出 PTY WS；session_exit 改 ANSI 字节提示，ready 删除，error 走 HTTP 或不入流 |
| 语义记录 | user/assistant 文本 turn | interaction-recorder.mjs | 持久化（data 目录） | 由 OSC 解析或空闲计时驱动 beginTurn/appendOutput/finishTurn |
| OSC 133 解析器 | PTY 输出流上的语义边界扫描器 | 新增 server/osc-parser.mjs | observer 级 | 只解析 A/B/C/D mark，不触碰可见文本归一化 |
| observer | 会话级语义观察者 | server.mjs createObserver | WS 连接级 | 协调输入识别、OSC 边界、记录生命周期 |

## 用户路径
### 主路径：进入终端做 shell 交互
- 入口：`/terminal?sessionId=...`
- 用户操作：进入终端 → 顶部无 JSON 首行 → 输入命令 → 看到正常 shell 输出
- 成功结果：终端首行是 shell prompt，不是 `{"type":"ready",...}`；输入跟在 prompt 后
- 失败反馈：session_exit 时显示灰色 `[session exited]`（ANSI 字节）
- 结果可见性：终端主区域

### 关键分支路径：进入 TUI（vim / pi）
- 入口：终端内输入 `vim` 或 `pi`
- 用户操作：TUI 启动 → 差分渲染序列原样透传 → 全屏交互无乱行
- 成功结果：TUI 光标定位/擦除/重绘正确，无 JSON 杂帧打断
- 失败反馈：—
- 结果可见性：终端主区域

### 关键分支路径：pi agent 回复被记录
- 入口：终端内 pi 对话
- 用户操作：用户提交消息 → pi 流式输出 assistant 回复（带 OSC 133 边界）→ 回复结束后写入记录
- 成功结果：右侧搜索面板能搜到该 turn 的 assistant 文本（归一化可见文本）；user 文本字段为 `"(input via TUI)"` 或留空（诚实降级）
- 失败反馈：OSC 缺失时回退空闲计时，可能切片不准但不崩
- 结果可见性：右侧搜索面板记录列表

## 用户可见闭环
| 需求 | 入口 | 操作 | 成功可见结果 | 失败反馈 | 结果/状态可见位置 |
|------|------|------|--------------|----------|------------------|
| R-001 PTY WS 纯字节 | 终端页 | 进入终端 | 无 JSON 首行，shell prompt 正常 | — | 终端主区域 |
| R-002 客户端只 write 字节 | 终端页 | 交互 | 输入跟在 prompt 后，不跟在 JSON 后 | — | 终端主区域 |
| R-003 JSON 帧移出通道 | 终端页 | agent 对话 | 终端无重复延伸输出 | — | 终端主区域 |
| R-004 OSC 解析器 | 服务端 | pi 输出 | A/B/C mark 被识别 | OSC 缺失回退 | 日志 |
| R-005 observer OSC 边界 | 右侧面板 | pi 对话结束 | assistant 回复进记录 | 空闲计时兜底 | 右侧记录列表 |
| R-006 stripAnsi 保留 OSC | 服务端 | 归一化 | OSC 边界解析后再剥 | — | 记录文本 |
| R-007 TUI 输入降级 | 右侧面板 | pi 对话 | user 字段占位非乱码 | — | 右侧记录 userTextPreview |

## 页面/入口覆盖
| 页面/入口 | 类型 | 覆盖需求 | 关键状态 | 反馈要求 |
|-----------|------|----------|----------|----------|
| 终端主区域 - Terminal | UI | R-001,R-002,R-003 | running / exited | 无 JSON 噪声；session_exit ANSI 提示 |
| 右侧搜索面板 | UI | R-005,R-007 | idle / match_results | 记录列表含 pi 回复 |
| WS `/ws/pty/:sessionId`（服务端） | WS | R-001,R-003 | — | 只发字节 |
| OSC 解析器（服务端） | 模块 | R-004,R-005 | — | 解析日志 |
| HTTP `/api/records/*`（服务端） | API | R-005 | — | 记录读写（已存在，不依赖 WS） |

## 关键决策
| 决策 | 结论 | 理由 | 影响 | 状态 |
|------|------|------|------|------|
| DECIDE-001 | PTY WS 退回 wterm 官方纯字节契约 | 对齐 `wterm/examples/local`；wterm 终端核心只接受字节流，JSON 会被当可见字符渲染；wterm/pi 升级不破坏 | 服务端 bindPtyWebSocket 只发字节 + ANSI resize | 已确认 |
| DECIDE-002 | 记录/搜索完全走 HTTP 不依赖 WS 推送 | 客户端右侧面板已用 debounced `/api/records/search`；`api.ts` 全 HTTP；移除 agent_reply 的 sendWs 零功能损失 | 删除 ready/user_message/agent_reply/session_exit 的 WS send | 已确认 |
| DECIDE-003 | 用 OSC 133 解析替代空闲计时识别 pi 的 user/assistant | pi 主动用 OSC 133 A/B/C 标注边界（源码确认）；行业协议（iTerm2/VS Code/WezTerm 标准）；空闲计时对差分渲染流式输出失效 | 新增 osc-parser.mjs；observer 用 OSC 边界驱动记录生命周期 | 已确认 |
| DECIDE-004 | 检测不到 OSC 时回退现有空闲计时兼容普通 shell | bash/cmd 不发 OSC 133；回退保证不回归普通 shell 场景 | observer 双路径：OSC 优先，缺失则空闲计时 | 已确认 |
| DECIDE-005 | pi 场景 user 文本字段诚实降级不塞乱码 | pi-tui raw mode 自处理输入，不回显 stdout，无法从输出流获取 user 文本；塞控制字符是更差选择 | user 文本记 `"(input via TUI)"` 或留空，assistant 文本为准 | 已确认 |
| DECIDE-006 | OSC 解析在 stripAnsi 之前执行 | stripAnsi 会剥掉 OSC 序列；先消费语义边界再归一化可见文本 | observer 先跑 OSC 解析，再调 normalizeVisibleText | 已确认 |
| DECIDE-007 | session_exit 用 ANSI 字节提示非 JSON | 保持 PTY WS 纯字节契约；wterm 官方用 `\r\n\x1b[90m[session ended]\x1b[0m\r\n` | bindPtyWebSocket exit 分支发 ANSI | 已确认 |
| DECIDE-008 | resize 保持现有 `{_ctrl:{type:'resize'}}` 不改 | 现有 maybeHandleControlMessage 已正确剥离；改成 `\x1b[RESIZE:]` ANSI 伪装是等价替换无收益 | 不动 resize 路径 | 已确认 |

## Agent/AI 节点需求
| 节点 | 任务类型 | Agent/LLM 倾向 | 角色边界 | 工具/上下文需求 | 自主度 | 失败风险 |
|------|----------|----------------|----------|------------------|--------|----------|
| pi coding agent | 编码辅助（流式 TUI 输出） | Agent（pi SDK 内置循环 + 差分渲染） | 可读写文件、执行命令、编辑代码；通过 OSC 133 暴露语义边界 | 工作目录、用户消息（TUI 内输入）、模型配置 | 高自主（自动工具调用） | OSC 边界解析错误导致记录切片不准 |

## 本期范围
- R-001: 服务端 `bindPtyWebSocket` PTY WS 通道退回纯字节契约，移除 `ready`/`user_message`/`agent_reply` 的 `sendWs` JSON 帧，session_exit 改 ANSI 字节提示
- R-002: 客户端 `TerminalWorkspace.tsx` 的 `ws.onmessage` 严格只 `write` 字节流，移除对字符串的无条件写入（保留防御性丢弃 JSON 信封）
- R-003: JSON 控制帧完全移出 PTY WS 通道，记录/搜索走既有 HTTP `/api/records/*`（已存在），确认无前端消费者依赖 WS 推送
- R-004: 新增 `server/osc-parser.mjs`，实现 OSC 133（A/B/C/D）状态机扫描 PTY 输出流，输出语义边界事件
- R-005: 重写 `observeOutput`，用 OSC 边界替代 `REPLY_IDLE_MS` 空闲计时识别 assistant 回复；OSC 缺失时回退空闲计时兼容普通 shell
- R-006: `stripAnsi` 调用顺序修正，OSC 解析在归一化之前执行，保留语义边界不被擦除
- R-007: TUI 场景（检测到 OSC）下 `observeInput` 放弃逐字符 echo 推断，user 文本字段诚实降级为占位，避免控制字符乱码

## 后续候选
- 独立 `/ws/records` 实时推送通道（若右侧面板需实时刷新而非 debounced 轮询）
- 右侧搜索面板 UI 重构（流式更新、记录分组）
- pi 进程内 SDK 集成（替代 PTY 启动 pi，直接拿到结构化事件而非解析字节流）
- OSC 133 D（exit code）深度利用，记录命令退出状态
- 记录全文搜索增强（按 tool call、按文件路径）

## 不做范围
- 主题/暗色模式：与通道修复无关
- 多 session 并发隔离：现有单 session 模型够用
- Kitty 键盘协议协商处理：wterm/dom 层职责，不在 server
- pi 会话 JSONL 双写去重：PTY 流与 SDK 持久化的去重是后续架构问题
- 移动端适配

## 验收标准
- A-001: 进入终端 `/terminal?sessionId=...`，顶部首行是 shell prompt，不出现 `{"type":"ready",...}` JSON
  - 关注点：前端可见性
- A-002: 在终端输入字符，字符跟在 shell prompt 后，不跟在任何 JSON 文本后
  - 关注点：前端可见性
- A-003: 在终端启动 vim 或 pi，全屏 TUI 差分渲染正确，无字符乱行/混在一起
  - 关注点：前端可见性（TUI 渲染正确性）
- A-004: pi agent 流式输出回复时，终端不出现重复延伸的输出，只渲染一次
  - 关注点：前端可见性
- A-005: pi 对话结束后，右侧搜索面板能通过 `/api/records/search` 搜到该 turn 的 assistant 回复文本（归一化可见文本）
  - 关注点：后端事实（OSC 解析正确）、前端可见性
- A-006: pi 场景下记录的 user 文本字段为 `"(input via TUI)"` 或留空，不含控制字符乱码
  - 关注点：后端事实（诚实降级）、数据质量
- A-007: 普通 shell（bash/cmd，不发 OSC 133）下，agent 回复识别回退到空闲计时，记录功能正常不回归
  - 关注点：后端事实（回退路径）、回归保护
- A-008: session 退出时终端显示灰色 `[session exited]`（ANSI 字节），不显示 JSON
  - 关注点：前端可见性、后端事实（纯字节）

## 假设
- 假设 wterm 0.3.0 的 WASM 终端核心正确处理差分渲染序列（vim/pi ANSI）
- 假设 pi 持续输出 OSC 133 边界（源码已确认 user-message.ts / assistant-message.ts）
- 假设普通 shell（bash/cmd）不发 OSC 133，回退空闲计时路径可用
- 假设 pi-tui raw mode 下用户输入不回显 stdout（源码已确认 terminal.ts:134-144）
- 假设右侧搜索面板 debounced `/api/records/search` 能满足记录可见性（已存在）
- 假设单 session observer 模型够用，无需并发隔离

## 待决策项
- P0（R-001~R-003，修三 bug）与 P1（R-004~R-007，pi 记录识别）是否分两次提交：建议分两次，P0 验证 TUI 不乱行后再做 P1，降低回归风险。需用户确认节奏。

## 特别关注点
- wterm 终端核心只接受字节流，任何 JSON 字符串被 write 都会渲染为可见文本（问题根因）
- pi-tui 差分渲染输出大量 ANSI 光标定位/擦除序列，JSON 帧注入会破坏光标重绘基准
- pi 用 OSC 133 标注 user/assistant 边界，是可解析的语义信号而非噪声
- pi-tui raw mode 不回显用户输入，user 文本无法从输出流获取，必须诚实降级
- OSC 解析必须在 stripAnsi 之前，否则边界被擦除
- 普通 shell 回退路径必须保留，避免回归

## 技术阶段必须确认的问题
- OSC 133 解析器如何处理跨 chunk 的分裂序列（A mark 可能被 TCP 分包拆到两个 data 事件）
- pi 的 OSC 133 A/B/C 三段在差分渲染重绘时是否每次重绘都重发（若是，解析器需去重避免重复 beginTurn）
- observer 在 OSC 模式与空闲计时模式之间如何平滑切换（检测到首个 A mark 即切换，还是一直双跑）
- session_exit 的 ANSI 提示字节是否需要考虑 wterm 的 scrollback 行为
- pi agent_reply 归一化文本是否需要保留 Markdown 结构（当前 normalizeVisibleText 会扁平化）
- 多 turn 对话时 OSC 边界与既有 recordFinalized/superseded 逻辑如何协同
- TUI 输入降级后，右侧面板的搜索 query（基于 inputBuffer）对 pi 是否仍有意义

## 交接给 tech-design
- 需求：R-001, R-002, R-003, R-004, R-005, R-006, R-007
- 验收：A-001, A-002, A-003, A-004, A-005, A-006, A-007, A-008
- 功能概览：PTY WS 纯字节化 + 客户端只 write 字节 + OSC 133 语义解析替代空闲计时
- 呈现形态：服务端 WS + 客户端 React + 服务端 OSC 模块
- 主要入口：`/terminal?sessionId=...`
- 核心机制：PTY WS 只发字节（对齐 wterm 官方）→ 客户端 write 字节 → 服务端 OSC 解析 PTY 输出流语义边界 → 驱动 interaction-recorder 记录 → 右侧面板 HTTP 查询
- 关键对象：PTY 字节通道、控制信令、语义记录、OSC 解析器、observer
- 关键决策：DECIDE-001~DECIDE-008
- 用户可见闭环：7 个需求均有完整闭环
- 页面/入口覆盖：5 个入口（2 UI + 1 WS + 1 模块 + 1 API）
- 验收关注点：前端可见性、后端事实（OSC 解析/回退）、数据质量、回归保护
- Agent/AI 节点：pi coding agent（流式 TUI + OSC 133）
- 特殊约束：不修改 wterm/pi、OSC 先于 stripAnsi、普通 shell 回退、TUI 输入降级
- 高风险假设：pi 持续输出 OSC、普通 shell 回退可用
- 特别关注点：wterm 只吃字节、差分渲染怕 JSON 注入、OSC 是信号非噪声、pi 不回显输入
- 技术阶段必须确认：跨 chunk 分裂、重绘重发去重、OSC/空闲双模式切换、exit ANSI、Markdown 保留、多 turn 协同、TUI 搜索 query 意义
- 实施节奏建议：P0（R-001~R-003）先提交验证，P1（R-004~R-007）后提交

## 审查记录
| 审查项 | 结果 | 问题或证据 |
|--------|------|------------|
| 需求不是模块清单 | 通过 | 每个 R-* 描述用户可观察能力，非文件名 |
| 每个 R-* 有可观察 A-* | 通过 | 7 个 R-* 均有对应 A-* |
| 每个 R-* 有用户可见闭环 | 通过 | 入口/操作/成功/失败/可见性完整 |
| 页面/入口覆盖完整 | 通过 | 5 个入口覆盖 7 个需求 |
| 验收关注点完整 | 通过 | 每条 A-* 有关注点 |
| 范围边界清楚 | 通过 | 本期/后续/不做三列分明 |
| 关键对象和边界清楚 | 通过 | 5 个对象均有定义 |
| Agent/AI 节点需求清楚 | 通过 | pi coding agent 节点有完整描述 |
| 特别关注点已继承 | 通过 | 6 条特别关注点 |
| 技术阶段必须确认的问题已列出 | 通过 | 7 个技术确认点 |
| 根因有源码证据 | 通过 | 每条根因引用具体 file:line |
