# nterminal 终端通道修复 技术设计

> 关联需求简报：`docs/2026-06-17-nterminal-pty-channel-fix.md`
> 关联代码提交：`eab452a`（refactor: remove libc references from package-lock.json and enhance OSC handling in server）
> 参考项目：`H:\newworkspace\example\warp`（架构基准）、`H:\newworkspace\example\tabby`（反模式对照）
> 设计日期：2026-06-18

## 审查摘要
| 项 | 结论 |
|----|------|
| 设计目标 | 用 `@xterm/headless` 作为服务端单一 VT 状态机，替代手写 `osc-parser.mjs` + `normalizeVisibleText(replyBuffer)` 双路反推；对齐 Warp 的"单一 parser + grid 真相"架构，并自研 turn 生命周期层（Warp 不支持 inline 差分渲染 TUI 的结构化记录） |
| 核心变更 | 新增 `server/terminal-observer.mjs`（封装 headless Terminal + turn 状态机 + grid snapshot）；删除 `server/osc-parser.mjs`；改造 `server.mjs` 的 `observeInput/observeOutput/flushAgentReply/bindPtyWebSocket` |
| 新增依赖 | `@xterm/headless@^5.5.0`（已在 `pi-mono/node_modules` 验证可用，纯 Node 零运行时依赖，xtermjs 官方维护） |
| 与 Warp 差异 | Warp 对不用 alt-screen 的 inline TUI（pi）直接 drop 重绘 mark、不记录 turn；nterminal 必须记录，故 turn 状态机层为 nterminal 原创 |
| 主要风险 | (1) pi 多轮 assistant 的重绘模型未经验证（追加 vs 擦除重绘）；(2) resize 历史重绘会重发混合 user/assistant 的 OSC mark，role 标注无干净解；(3) `.write()` 异步性要求 snapshot 必须在 OSC handler/write callback 内 |
| 阶段划分 | P1a（grid snapshot 地基，最高风险先验证）→ P1b（turn 状态机）→ P1c（回退与平滑切换）→ P1d（role 标注 spike，独立） |

## 1. 背景与现状

需求简报 R-001~R-007 已锁定方向：PTY WS 退回纯字节契约（P0，已合入 `eab452a`）、OSC 133 解析替代空闲计时识别 pi 的 user/assistant（P1）。

`eab452a` 已实现 P0（纯字节化）和 P1 的初版（`osc-parser.mjs` + `oscDetected` + OSC 去抖），但 Review 发现 P1 初版有结构性缺陷：

| 缺陷 | 证据 | 影响 |
|------|------|------|
| 手写 OSC 扫描器 buffer 不裁剪 | `osc-parser.mjs:67,104` 两个 break 分支不 `buffer.slice(i)` | O(n²) 重扫 + 重复 emit mark，长 pi 会话性能毒药 |
| 重扫字节流 = 第二套状态机 | `osc-parser.mjs` 与未来 grid 仿真器各自解析同一字节流（tabby `OSCProcessor` 同款劣化模式，至今未长出 OSC 133） | 跨 chunk/终止符/alt-screen 各自重造，易漂移 |
| `normalizeVisibleText(replyBuffer)` 对差分渲染无效 | `server.mjs:201,235` 累积原始字节 + `text-utils.mjs:20` 仅 stripAnsi | pi 每帧 cursor-up/erase/reprint 碎片被拼接 → 重复错乱，A-005 不可达 |
| `oscDetected` 一旦置位永不复位 | `server.mjs:206-208` | 退出 pi 回 shell 后 buffer 不 flush，DECIDE-004 回退未真正实现 |
| 客户端 `looksLikeJsonEnvelope` 会吞合法输出 | `TerminalWorkspace.tsx:26-33` 匹配 `{"type":...}` | shell `echo` JSON 文件被静默吃掉 |
| OSC 重绘 mark 无去重 | `server.mjs:209-211` 每帧 C 只重置去抖，无 turn 概念 | 文档第 204 行开放问题未处理 |

本设计针对以上 P1 缺陷重构，不改 P0 已合入的纯字节契约。

## 2. 参考项目调研结论

### 2.1 Warp（架构基准）
- **单一 VT 状态机**：`Processor`/`VteParser` 持久化在 event-loop `State`（`app/src/terminal/model/ansi/mod.rs:364-381`，`local_tty/event_loop.rs:250-254,335-336`），同一实例跨 read 复用，跨 chunk 由 vte 内部状态免费处理，应用层零缓冲。
- **OSC 133 是一个 dispatch 臂**：`osc_dispatch` match `b"133"` → `PromptMarker::try_from`（`mod.rs:983-990`）。**仅实现 A/B/P，C/D 被 `_ => Err` drop**（`control_sequence_parameters.rs:648-681`），exit code 走自定义 DCS `CommandFinished`（`dcs_hooks.rs:415-421`）。
- **alt-screen 路由**：`delegate!` 宏按 `alt_screen_active` 标志在 `AltScreen` grid 与 `BlockList` 间路由（`terminal_model.rs:2259-2267`）。DEC `?1049`/`?47` 触发（`control_sequence_parameters.rs:142-147`）。进 alt-screen **不** finalize/suspend 当前 block，仅复制光标（`terminal_model.rs:1966-2011`）。
- **block 生命周期**：block 在 `CommandFinished` 时创建+密封（`blocks.rs:3027-3048`），不在 `PromptStart`。PTY-exit 兜底密封：`TerminalModel::exit` → `active_block_mut().finish(0)`（`terminal_model.rs:1455-1470`）。无空闲计时。
- **重绘"去重"实为状态守卫**：`BlockList::prompt_marker` 在 `state() != BeforeExecution` 时 return（`blocks.rs:3685-3692`）。shell prompt 一周期画一次，执行期间重发的 mark（如 pi）全 drop。**Warp 不记录 pi 的 turn**，drop 正合其意。
- **BEL vs ST**：`bell_terminated: bool` 由 vte 传入，仅用于格式化回复，不影响解析（`mod.rs:773-776`）。

### 2.2 关键结论：Warp 架构不能完全套用 pi
Warp 对 inline 差分渲染 TUI（pi，不用 alt-screen）的处理是"重绘 mark 全 drop，block 只剩最后一帧"。nterminal 的目标恰是**记录 pi 的 assistant turn**，故：
- 架构骨架（单一 VT 状态机 + grid 真相 + alt-screen 路由）照搬 Warp；
- **turn 生命周期层为 nterminal 原创**——不能照搬 Warp 的 `BeforeExecution` 守卫 drop。

### 2.3 tabby（反模式对照）
`OSCProcessor`（`tabby-terminal/src/middleware/oscProcessing.ts`）是独立重扫字节流的第二状态机，手写 `this.buffer` 跨 chunk、最早终止符匹配启发式，至今只支持 OSC 1337/52，**未长出 OSC 133**。这正是 `osc-parser.mjs` 要避免的模式。

### 2.4 `@xterm/headless`（Warp `vte` 的 Node 等价物）
- 纯 Node 零运行时依赖（`package.json` 无 `dependencies`），无 DOM/`open()`。v5.5.0 已在 `pi-mono/node_modules/@xterm/headless` 验证。
- 完整 VT 状态机：alt-screen、bracketed-paste、IRM 等内部处理（`IModes`、`IBuffer.type: 'normal'|'alternate'`）。
- 关键 API：
  - `term.write(data: string|Uint8Array, cb?)`（接受 raw PTY 字节，UTF-8）
  - `buffer.active.getLine(y).translateToString(trimRight)`（grid 行直读，宽字符正确）
  - `buffer.active.cursorY/cursorX/baseY/length`、`term.registerMarker(0).line`
  - `term.parser.registerOscHandler(133, data => boolean)`（OSC 133 搭同一 parser，消除双扫描）
  - `buffer.active.type === 'alternate'`（alt-screen 检测）、`buffer.onBufferChange`
  - `term.resize(cols, rows)`、`scrollback` option（默认 1000）
- **差分渲染在 grid 上正确收敛**：xterm 真正执行 `CSI K`(EL)/`CSI J`(ED)/`CSI A`(CUU)/`CR`，erased cell 被清空、reprinted cell 覆盖，N 帧后 grid 只剩最终可视状态。这是 grid snapshot 能还原可见文本的根本原因。
- **`.write()` 非完全同步**：`WriteBuffer` 对大块用 `setTimeout(0)` 分片，`cb` 在该批解析完才触发。snapshot 必须在 OSC handler 内或 write cb 内，不可 `write(d); snapshot();` 同步。

## 3. 方案总览

数据流：

```
PTY data event
   ├─ ws.send(bytes)              → 前端 wterm（纯字节契约，P0 不变）
   └─ observer.feed(bytes)        → @xterm/headless Terminal
                                    │
                  parser.registerOscHandler(133)  → turn 状态机
                  buffer.active.type === 'alt'    → vim/less 隔离
                  buffer.active.getLine(y)        → 可见文本还原
                                    │
                                    └─ interaction-recorder (beginTurn/appendOutput/finishTurn)
```

PTY 字节"双写"：一份数据原样给前端 wterm，一份喂 headless 旁路记录（与 Warp 一致：PTY 字节同时喂渲染 grid 和 block 逻辑）。

删除项：
- `server/osc-parser.mjs`（整个文件）
- `observeOutput` 的 `replyBuffer` 累积（`server.mjs:201`）
- `flushAgentReply` 的 `normalizeVisibleText(replyBuffer)`（`server.mjs:235`）
- `oscDetected` 布尔标志（`server.mjs:206-208`）
- `text-utils.mjs` 的 `stripAnsi/normalizeVisibleText` 仅保留给 `makePreview`，不再用于 agent reply 文本还原

新增：
- `server/terminal-observer.mjs`：封装 headless Terminal + turn 状态机 + grid snapshot
- `@xterm/headless@^5.5.0` 依赖

## 4. 详细设计

### 4.1 第 2 点：跨 chunk 分包——交给 xterm parser（R-004 重做）

**Warp 做法**：`vte::Parser` 状态机持久化，部分序列内部缓冲，下次续传。

**nterminal 方案**：`@xterm/headless` 的 `Terminal` 实例即持久化状态机。`term.write(chunk)` 切在序列中间由 xterm 内部缓冲续传。删除 `osc-parser.mjs`，OSC 133 由 `term.parser.registerOscHandler(133, …)` 消费——搭在维护 grid 的同一 parser 上，跨 chunk 一致性免费，BEL/ST 由 xterm 处理。

### 4.2 第 3 点：差分渲染可见文本还原——grid snapshot（R-005 重做）

**Warp 做法**：维护真实 grid，命令结束 grid 即最终可视状态，无需"还原"。

**nterminal 方案**：headless grid 真正执行 erase/ reprint，N 帧后只剩最终状态。还原可见文本 = 读 grid 行：

```js
function snapshotReply(term, startLine, endLine) {
  const buf = term.buffer.active;
  const end = endLine ?? (buf.baseY + buf.cursorY);
  const start = startLine ?? buf.baseY;
  const lines = [];
  for (let y = start; y <= end; y++) {
    const ln = buf.getLine(y);
    if (ln) lines.push(ln.translateToString(true));
  }
  return lines.join('\n').replace(/\n+$/, '').trim();
}
```

工程要点：
1. **snapshot 位点**：必须在 OSC 133 handler 内或 `term.write(d, () => snapshot())` cb 内。OSC C handler 在解析期触发，此时 C 之前字节已全部 apply，handler 内 snapshot 安全。

**Task#2 spike 实测验证（2026-06-18，`workplace/1.1/test/spike/`）**：用 Task#1 的 pi 真实流喂 `@xterm/headless@5.5.0`，结论：
- ✅ **grid snapshot 对差分渲染有效**：reply 结束时 grid 第 27 行是干净的 assistant 文本"自我调用：函数在执行过程中调用自身..."，**无转义符、无 OSC、无重复碎片**。证明 xterm grid 真正执行了 pi 的 cursor-up/erase/reprint，最终可视状态干净。**A-005 可达，地基成立。**
- ✅ **Q3 异步性确认**：同步 `term.write(d)` 后立即读 `buffer.active` 得到空 grid（解析在 `setTimeout(0)` 分片里完成），必须用 write callback 或在 OSC handler 内 snapshot。**`allowProposedApi: true` 必须设置**（`term.buffer` 是 proposed API）。
- ⚠️ **布局发现**：pi 的 grid 结构是 `启动屏(Context/Skills/Update面板) + 对话区 + status bar`，对话区在 scrollback 中部，**不是 viewport 顶部**。`baseY..baseY+ROWS` 的 viewport snapshot 抓的是静态面板，必须用 OSC A mark 的 `registerMarker(0)` 定位对话区。
- ⚠️ **marker 边界错位**：实测 `userMarker.line=27`（恰是 assistant 文本行）、`assistantMarker.line=30`（文本之后），即 pi 差分重绘下 A mark 的行位置与最终文本行**会错位**（spinner 在消息上下跳动、光标乱移）。单纯"从 A marker 到 C/cursor"会漏或错文本。**消息文本可能跨 marker 边界**——turn 状态机 snapshot 应取较宽范围（从首个 user marker 到 cursor）再用内容启发式切分，或接受 user+assistant 合录后由 P1d role spike 切分。
- ⚠️ **spinner 混入**：pi 流式时 braille spinner `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` 与回复同区，snapshot 需过滤 spinner 字符（正则 `/[⠋-⠏]/g`）。
- ⚠️ **录制时长不足**：本次 `PI_WAIT_INPUT=25000ms` 不够，assistant 只输出 1 条要点即触发 resize，回复不完整。P1a 实现时需更长等待或事件驱动（等 spinner 消失/C 后无新 mark）。
2. **resize 同步**：前端 resize → 同时 `resize(sessionId, cols, rows)`（PTY）和 `observer.resize(cols, rows)`（headless）。漏掉则 grid 列宽与真实终端不符，pi 按真实宽度算的 cursor-up 行数与 grid 错位 → snapshot 乱行。当前 `server.mjs:583` 只 resize PTY，需补 `observer.resize`。
3. **scrollback 取舍**：`scrollback: 2000`。太低 → 长 reply 的 turnStart marker 被 FIFO 裁掉；太高 → 长会话内存增长。snapshot 时若 `turnStartMarker.line` 变 -1（age out）则回退 `buf.baseY`。
4. **UTF-8/宽字符**：`translateToString` 正确处理 CJK/emoji 宽度，无需手动 wcwidth。

### 4.3 第 4 点：OSC mark 重绘去重——turn 状态机（R-005 核心）

**Warp 不能照搬**：Warp 的"去重"是 `BeforeExecution` 状态守卫 drop 执行期间 mark；nterminal 必须记录 pi turn，不能 drop。

**pi 行为（已确认源码）**：`user-message.ts:39-40`、`assistant-message.ts:68-69` 的 `render()` 每次重绘都重拼 `A...B C`。流式输出每 token 到达整条消息重绘，每帧发一组 `A...B C`。一个 assistant turn 期间收到大量 `A...B C`，每组对应一帧。grid 始终是该消息当前最终状态。

**真实流验证结论（Task#1，2026-06-18，pi v0.73.0）**：录制真实 pi 对话流（`workplace/1.1/test/fixtures/pi-real-stream.*`）后，pi 的 OSC 133 实际协议**修正了本节原始假设**：
- **启动屏无 OSC 133**（idx 0~15 全无 mark）——OSC 133 只由 `UserMessageComponent`/`AssistantMessageComponent` 发，welcome/banner/status bar 不发。
- **流式回复不是"每帧 ABC"**，而是 **首帧 `ABC` + 后续帧 `BC`**：user 消息 1 次 ABC；assistant 消息首帧 1 次 ABC，之后每个 token 重绘只发 `BC`（不带 A）。实测一轮回复：reply 阶段 A=2（user 首帧 + assistant 首帧）、B=28、C=28，模式分布 `{ABC:2, BC:26}`。
- **`A` 不与"turn 开始"一一对应**：A 只在消息首帧出现，后续重绘帧无 A。因此原状态机"收到 A 开新 turn"对 assistant 流式无效（首帧后无 A）。
- **resize 重发完整 ABC**（§6.3 确认）：resize 触发 pi 重绘屏上所有消息，每条完整重发 `ABC`。实测 resize 后单事件 `ABCABC`（user+assistant 两条）。

基于此，turn 状态机修订如下（替换下方原 `IDLE/IN_REPLY` 逻辑）：

**turn 状态机**（修订版）：状态 `IDLE` / `IN_REPLY`

```
收到 A（且 buffer.active.type === 'normal'，非 alt-screen）：
  - 记 zoneStart = term.registerMarker(0)（消息渲染起点）
  - 不立即开 turn：等配对的 C 才确认是一次消息渲染
  - resize 重发的 ABC 也走此路径 → 需去重（见下）

收到 B：忽略（pi 的 B 紧跟 A 或在 BC 帧中，无独立语义需求）

收到 C（且非 alt-screen）：
  - 重置 finalize 去抖（OSC_DEBOUNCE_MS=300ms）
  - 去抖触发（300ms 内无新 A/C）→ snapshotReply(term, zoneStart, cursor) 取该消息文本
    → 与上一条已录消息文本对比去重（resize 重绘的 ABCABC 两条会产出与已录相同的文本 → 丢弃，不重复录）
    → 若为新内容 → recordReply + finishTurn → zoneStart = null
  - 流式期间的 26 个 BC 帧：每个 C 重置去抖，不立即 snapshot；流式结束最后一个 C 后 300ms 触发一次性 snapshot

alt-screen 期间：所有 mark 忽略；IN_REPLY 挂起（不 finalize，等退出 alt-screen）
```

去重机理（修订）：pi 流式回复每帧发 `BC`（无 A），故 A 不能当 turn 起点。改为以 `zoneStart`（A 时 marker）+ `C`（帧完成）配对，C 后去抖 300ms 无新 mark 即 finalize。resize 重发的完整 `ABC` 组会产出与已录消息相同的 snapshot 文本 → 内容去重丢弃，不重复录。流式期间每帧 C 只重置去抖不 snapshot，流式结束一次性取最终 grid（grid 是最终可视状态，差分碎片已被 erase 覆盖，不重复）。

与初版差异：初版（`server.mjs:209-211`）去抖方向对，但 (a) `replyBuffer` 累积 raw 字节错（§4.2）；(b) 每帧 A 无 turn 去重，靠"A 不触发动作"巧合，无 turnStart 概念，`flushAgentReply` 用整个 buffer 故重复。新方案 turnStartMarker + grid snapshot 解决。

### 4.4 第 5 点：oscDetected 不复位 + 回退——alt-screen 检测 + 显式回退（R-007）

**Warp 做法**：`alt_screen_active` 标志显式路由，不回退空闲计时（假设 shell 必发 DCS）。nterminal 普通 shell 不发 OSC 133，必须回退。

**nterminal 方案**：两个独立信号替代单一 `oscDetected` 布尔：

1. **alt-screen 检测**（vim/less/top）：`term.buffer.active.type === 'alternate'`。alt-screen 期间暂停 turn 状态机（不 snapshot 不录），退出恢复。Warp `delegate!` 路由的 Node 映射。
2. **OSC 模式与空闲计时平滑切换**（DECIDE-004 落地，P1c 已实现）：
   - `OSC_DEBOUNCE_MS`（300ms）：任意 OSC mark 重置，静默后 finalize 当前回复。
   - `OSC_STALE_MS`（5000ms，env `POC_OSC_STALE_MS`）：自最后 OSC mark 计时；超时 → `mode` 回 `idle`（仅切模式，不 finalize turn——若仍有未 finalize 回复，由后续 idle 计时或 `flushNow` 兜底）。`armStale()` 在每次 OSC mark 重置；`flushNow`/`dispose` 清 stale 计时避免误切。
   - 普通 shell（从不发 OSC 133）：OSC 分支永不触发，`mode` 恒 `idle`，**完全回退 `REPLY_IDLE_MS` 空闲计时**，snapshot 用 grid（§4.2）。bash/cmd 不回归（A-007，P2 验证）。
   - pi → 退 pi → shell：pi 退出后不发 OSC，`OSC_STALE_MS` 超时 `mode` 切回 `idle`，下个 user turn 走 idle 计时 + grid snapshot 录（P3 验证）。流式期间 mark 间隔远小于 `OSC_STALE_MS`，不误切（P4 验证）。
3. **删除 `oscDetected`**：改用 turn 状态机 `mode: 'osc'|'idle'`，由 stale 计时动态决定。`observeInput` 不再分支（user 文本自输入按键直捕，与 mode 无关）。

### 4.5 第 6 点：架构——单一 VT 状态机（Warp `delegate!` 的 Node 映射）

**nterminal 现状反模式**：`osc-parser.mjs`（重扫第二状态机）+ `normalizeVisibleText`（第三套半解析）在同一字节流各自为政，跨 chunk/终止符/alt-screen 各自重造。

**目标架构**：`@xterm/headless` 是唯一 VT 状态机，所有序列消化/grid 维护/alt-screen 切换/跨 chunk 缓冲由它负责。nterminal 只在扩展点挂业务逻辑：

| Warp 概念 | Warp 实现 | nterminal 映射（xterm-headless） |
|-----------|-----------|----------------------------------|
| 单一 VT parser | `VteParser`（持久化） | `Terminal` 实例（持久化，`write` 续传） |
| OSC 133 dispatch 臂 | `osc_dispatch` match `b"133"` | `parser.registerOscHandler(133,…)` |
| alt-screen 路由 | `delegate!` 宏 + `alt_screen_active` | `buffer.active.type === 'alternate'` |
| grid 还原 | block output grid | `buffer.active.getLine(y).translateToString(true)` |
| DCS CommandFinished（exit code） | 自定义 DCS hook | （后续候选）`registerDcsHandler` 或 OSC 133 D |
| block 创建/密封 | `CommandFinished` → `finish`+`create_new_block` | turn 状态机：A 开 turn、C+去抖 finalize |
| PTY-exit 兜底密封 | `TerminalModel::exit` → `finish(0)` | `bindPtyWebSocket` exit → `finalizeRecord` |

新增 OSC 消费者（OSC 8 超链接、OSC 7 CWD、OSC 133 D exit code）：各加一个 `registerOscHandler`/`registerDcsHandler`，零新增状态机。这是 Warp 架构核心收益——扩展点是 parser 注册回调，不是新写扫描器。

### 4.6 模块边界
```
server/
  terminal-observer.mjs   ← 新：headless Terminal + turn 状态机 + grid snapshot
  text-utils.mjs          ← 缩减：stripAnsi/normalizeVisibleText 仅留 makePreview 用
  (osc-parser.mjs 删除)
server.mjs
  createObserver()        ← 改：持有 terminal-observer，转发 feed/resize/dispose
  observeInput/observeOutput/flushAgentReply  ← 改：委托 terminal-observer
  bindPtyWebSocket        ← 改：data 双写、resize 同步、exit 兜底
```

`interaction-recorder.mjs`（beginTurn/appendOutput/finishTurn）API 不变。terminal-observer 在 turn 边界调用。`appendOutput` 可只 append 原始字节（供搜索/重放），可见文本还原走 grid snapshot 不依赖 appendOutput 内容。

## 5. 代码骨架（terminal-observer.mjs 核心）

```js
import { Terminal } from '@xterm/headless';

const OSC_DEBOUNCE_MS = 300;    // C 后等流结束
const OSC_STALE_MS = 5000;      // 无 OSC mark 超时 → 回退空闲模式
const IDLE_REPLY_MS = 1800;     // 普通 shell 空闲切片（沿用 REPLY_IDLE_MS）

export function createTerminalObserver({ sessionId, cwd, command, cols, rows, hooks }) {
  // hooks: { beginTurn, appendOutput, finishTurn, recordReply, activeRecordId, hasActiveUserTurn }
  const term = new Terminal({ cols, rows, scrollback: 2000, convertEol: false });

  let mode = 'idle';            // 'osc' | 'idle'
  let turnState = 'IDLE';       // 'IDLE' | 'IN_REPLY'
  let turnStartMarker = null;
  let finalizeDebounce = null;
  let staleTimer = null;
  let idleTimer = null;
  let inAltScreen = false;

  function snapshotReply() {
    const buf = term.buffer.active;
    const end = buf.baseY + buf.cursorY;
    let start = turnStartMarker?.line;
    if (start == null || start < 0 || start > end) start = buf.baseY;  // marker age out
    const lines = [];
    for (let y = start; y <= end; y++) {
      const ln = buf.getLine(y);
      if (ln) lines.push(ln.translateToString(true));
    }
    return lines.join('\n').replace(/\n+$/, '').trim();
  }

  function finalizeTurn() {
    if (finalizeDebounce) { clearTimeout(finalizeDebounce); finalizeDebounce = null; }
    if (turnState !== 'IN_REPLY') return;
    const text = snapshotReply();
    turnState = 'IDLE';
    turnStartMarker = null;
    if (text) hooks.recordReply(text);
    hooks.finishTurn(hooks.activeRecordId(), { endState: 'idle', error: null });
  }

  function armStaleTimer() {
    if (staleTimer) clearTimeout(staleTimer);
    staleTimer = setTimeout(() => {
      if (turnState === 'IN_REPLY') finalizeTurn();
      mode = 'idle';
    }, OSC_STALE_MS);
  }

  function checkAltScreen() {
    const now = term.buffer.active.type === 'alternate';
    if (now !== inAltScreen) {
      inAltScreen = now;
      if (now && finalizeDebounce) { clearTimeout(finalizeDebounce); finalizeDebounce = null; }
    }
  }

  term.parser.registerOscHandler(133, (data) => {
    checkAltScreen();
    if (inAltScreen) return true;
    const mark = data[0];
    mode = 'osc';
    armStaleTimer();
    if (mark === 'A') {
      if (turnState === 'IDLE') {
        turnStartMarker = term.registerMarker(0);
        turnState = 'IN_REPLY';
      }
      // IN_REPLY 下的 A = 同 turn 重绘帧，忽略（去重）
    } else if (mark === 'C') {
      if (turnState === 'IN_REPLY') {
        if (finalizeDebounce) clearTimeout(finalizeDebounce);
        finalizeDebounce = setTimeout(finalizeTurn, OSC_DEBOUNCE_MS);
      }
    }
    return true;
  });

  return {
    feed(bytes) {
      term.write(bytes);
      checkAltScreen();
      if (mode === 'idle' && hooks.hasActiveUserTurn()) {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => finalizeTurn(), IDLE_REPLY_MS);
      }
    },
    onUserEnter() { /* observeInput 检测 Enter：开 user turn，userText 占位 */ },
    resize(c, r) { term.resize(c, r); },
    get mode() { return mode; },
    dispose() {
      if (finalizeDebounce) clearTimeout(finalizeDebounce);
      if (staleTimer) clearTimeout(staleTimer);
      if (idleTimer) clearTimeout(idleTimer);
      term.dispose();
    },
  };
}
```

`server.mjs` 接线（`bindPtyWebSocket`）：

```js
// data 事件（server.mjs:510 附近）
if (event.type === 'data') {
  ws.send(event.data);                        // 前端纯字节（不变）
  observer.terminal.feed(event.data);         // 旁路 headless（新增）
  // appendOutput 仍可保留原始字节供搜索/重放
}

// resize（server.mjs:583 maybeHandleControlMessage）
if (ctrl.type === 'resize') {
  resize(sessionId, ctrl.cols, ctrl.rows);
  observer.terminal?.resize(ctrl.cols, ctrl.rows);   // 同步 headless grid（新增）
}

// exit（server.mjs:523）
observer.terminal?.dispose();
finalizeRecord(observer, 'session_exit', 'pty_exit');  // 兜底密封 = Warp TerminalModel::exit
ws.send(`\r\n\x1b[90m[session exited (code ${event.exitCode})]\x1b[0m\r\n`);
```

## 6. user/assistant role 标注——P1d spike 结论（2026-06-18）

### 6.1 协议层无 role 信号（已验证源码）
`user-message.ts:4-6` 与 `assistant-message.ts:5-7` 用**同一组** OSC 133 常量 `A...B C` 包全文。OSC 133 原为 shell 设计（A=prompt 开始、B=命令开始、C=输出结束），pi 挪用包自己的 user/assistant 消息，丢弃了"B=命令输入边界"语义。单看 mark 字符（A/B/C）**看不出**这条是 user 还是 assistant。Warp 区分靠 pi 不发的 DCS `Preexec`/`CommandFinished`，对 pi 无效。

### 6.2 P1d 实测发现：A..B 之间夹的文本 = 该消息可见文本（破局点）
解析 Task#1 真实流 reply 阶段所有 mark 事件（`p1d-ab-extraction-analysis.mjs`），发现 OSC 133 mark 的**位置语义被 pi 重新定义**：

| 帧 | seq | A..B 文本 | B..C 文本 | 含义 |
|----|-----|-----------|-----------|------|
| frame#1 (idx=16) | `ABC` | "用3个要点简短解释什么是递归..." | — | **user 消息首帧**：A..B 夹完整 user 文本 |
| frame#2 (idx=110) | `ABC` | (空) | — | **assistant 消息首帧**：A..B 时无文本（还没生成） |
| frame#11 (idx=157) | `BC` | — | "1. 自我调用：..." | assistant 流式增量帧：B..C 夹**该帧新增片段** |
| frame#18 (idx=182) | `BC` | — | "2. 基准条件：..." | 同上，下一要点增量 |
| idx=230 (resize) | `ABCABC` | 第1组="用3个要点..."(user) / 第2组="1.自我调用...2.基准条件...3.栈式展开..."(assistant 完整) | — | resize 重发：两组 A..B 各夹完整消息文本 |

**关键结论**：
- **A mark 开启一条消息**，A..B 之间夹该消息**当前的完整可见文本**（首帧=起始完整文本；resize 重发=完整文本）。
- **BC 帧（无 A）** 是该消息的差分增量帧，B..C 夹**本帧新增片段**，不是完整文本。
- 因此**单条消息文本可直接从 A..B 之间的字节提取**（strip ANSI/OSC），不必靠 grid snapshot 宽范围合录后再切分。

### 6.3 resize 风暴的结构（P1d 解析 idx=230）
resize 触发 pi 重绘整个可见对话，单 PTY 事件 `idx=230` 含 `ABCABC`（6 mark）。解析其结构（`p1d-resize-storm-analysis.mjs`）：

```
A..B = "用3个要点简短解释什么是递归，每点一行"        ← user 消息（第1组）
A..B = "1.自我调用... 2.基准条件... 3.栈式展开..."   ← assistant 消息（第2组）
```

三个区分信号全部成立：
- **S1 顺序固定**：resize 风暴 `ABCABC` = user(ABC) + assistant(ABC)，**首组 A..B = user，次组 A..B = assistant**。pi 按对话顺序渲染，user 总在 assistant 前。
- **S2 内容匹配**：resize 重发的 A..B 文本 == 已录消息文本 → 内容去重判定"历史重绘 vs 实时新消息"。
- **S3 时序窗**：idx=230 与上一 mark 间隔 19086ms（实时流式帧间隔 < 1s），且 resize 不伴随 Enter → 时序可区分"resize 风暴 vs 实时流"。

### 6.4 role 标注策略（P1d 设计 + 可行性验证，待 P1e 实现）
基于 §6.2/§6.3，role 标注有干净解，无需 grid 后切分：

1. **user 文本**：每个 user turn 内**首个 A mark** 的 A..B 文本（strip 后）。替代占位 `"(input via TUI)"`，升级为实文（§6.5 修正落地）。
2. **assistant 文本**：grid snapshot（P1b 已验证干净取完整 assistant 文本）。或拼接该 turn 所有 BC 帧的 B..C 增量——但 grid snapshot 更稳（差分碎片已被 erase 覆盖，P1b 验证）。assistant 首 A 的 A..B 为空（还没生成），**不能**用 A..B 取 assistant，须 grid snapshot。
3. **role 区分（turn-scoped aInTurn，关键修正）**：role 按 **turn 内 A 出现顺序**——每 turn 内第 1 个 A = user，第 2 个 A = assistant。**全局 aCount 奇偶不可靠**（跨 turn 会错位：turn1 有 3 个 A 则 turn2 user 落在偶数 aCount），必须按 turn 重置计数。P1b `setHasUserTurn(true)` 在 `flushUserMessage` 已复位 aCount——P1e 复用此 turn-scoped aCount，`aInTurn===1` 时记录 user A..B 文本，`aInTurn===2` 标 assistant。premature 抑制（P1b `aCount<2`）天然保证只到 assistant A 才 finalize。
4. **resize 去重**：finalize 后 `hasUserTurn=false` 闸门（P1b 已实现）使 resize 风暴的 ABCABC 整体 drop；resize 风暴即使被切分误判为新 turn，其 aInTurn=1 仍是 user 文本、aInTurn=2 仍是 assistant（P1d 验证），role 不污染——但内容与已录相同，S2 去重丢弃。
5. **历史重绘不污染**：resize 风暴发生在 turn 已 finalize 后（用户 resize 通常在回复结束后），被闸门 drop；若发生在 turn 进行中（边回复边 resize），A..B 文本与已录相同 → S2 去重。

**P1d 可行性验证**（`p1d-strategy-verify.mjs`，真实流回放 7/7 通过）：turn1 aInTurn=1 含 user 问题、aInTurn=2 存在（assistant 首 A 空）、resize 重发的 assistant 完整 3 要点在 aInTurn=2 且同 turn aInTurn=1 配对 user 文本、"exit" 作为下个 user turn 的 aInTurn=1、所有 aInTurn=1 块均为 user 文本。

### 6.5 DECIDE-005 修正（P1d 确认）
原 DECIDE-005 称"pi-tui raw mode 不回显输入，无法从输出流获取 user 文本"——**P1d 推翻**：pi 把 user 消息作为 `UserMessageComponent` 渲染到 stdout，发 `A..B C` 包**真实 user 文本**（§6.2 frame#1 实测）。user 文本可直接从 A..B 提取，`observeInput` 逐字符 echo 推断可废弃。role spike 成功 → user 文本从占位升级为实文。

### 6.6 结论
role 标注**有干净解**（A..B 文本提取 + A 顺序定 role + 内容去重），不阻断核心修复。P0/P1a/P1b/P1c 已交付 A-001~A-008（不需 role）。P1d spike 确认可行性与策略，**P1e 已实现** role 标注（OSC=assistant/idle=mixed）+ user 文本 A..B 捕获（`userTextFromOsc`，与 observeInput 双源校准）。user record 主源切换与 user/assistant 合录切分留 P1f（需 recorder API 扩展）。

## 7. 验收映射

| 验收 | 初版实现 | 新方案 | 机制 |
|------|---------|--------|------|
| A-003 TUI 不乱行 | 纯字节透传（P0 已修） | 同 + alt-screen 隔离不污染记录 | grid 路由 |
| A-004 agent 输出不重复延伸 | OSC 去抖 + replyBuffer（错） | turn 状态机 + grid 单一真相 | 重绘 A 去重 + erase 就地覆盖 |
| A-005 右侧面板搜到 assistant 文本 | normalizeVisibleText（对差分无效） | grid snapshot | `translateToString` |
| A-006 user 字段无乱码 | 占位（已对） | observeInput 按键直捕 + P1e A..B 校准（`userTextFromOsc`） | DECIDE-005 修正 |
| A-007 普通 shell 回退 | oscDetected 永不复位（回归风险） | mode 动态切换 + OSC_STALE_MS | 显式回退空闲计时 |
| A-008 session_exit ANSI | 已对 | 不变 | — |

## 8. 风险与必须验证的点

1. **✅ turn 状态机重绘模型（Task#1 已验证，2026-06-18）**：pi 流式回复**既非纯擦除重绘也非纯追加**，而是 **首帧 `ABC` + 后续帧 `BC`（无 A）** 的差分重绘。实测一轮：reply 阶段 `A=2 B=28 C=28`，模式 `{ABC:2, BC:26}`。结论：
   - `A` 只在消息首帧出现，**不能**作为"turn 开始"信号（assistant 流式首帧后无 A）。
   - turn 状态机已据实修订为"`A` 记 zoneStart marker + `C` 去抖 finalize + 内容去重"（§4.3 修订版），不再依赖"A 计数开 turn"。
   - "擦除 vs 追加"二分法不适用——pi 是差分重绘，最终可视状态由 grid 反映，grid snapshot 即正确文本（待 Task#2 spike 最终确认 grid 收敛）。
   - fixture：`workplace/1.1/test/fixtures/pi-real-stream.{jsonl,bin,meta.json}` + 分析脚本 `analyze-pi-stream.mjs`。
2. **✅ `.write()` 异步性（Task#2 已验证）**：同步 write 后 grid 空，必须用 write callback 或 OSC handler 内 snapshot。另：`allowProposedApi: true` 必设（`term.buffer` 为 proposed API）。
3. **🟠 resize 同步**：漏 `observer.resize` 导致 grid 列宽错位 → snapshot 乱行（§4.2 要点 2）。Task#2 未单独验证 resize 同步（录制里 resize 后 pi 全屏重绘，列宽变化已体现），P1a 实现时接线验证。
4. **🟠 scrollback 与 marker age out**：长 reply `turnStartMarker.line` 可能变 -1，snapshot 回退 baseY 可能多录屏顶历史。`scrollback: 2000` + 真实流调参（§4.2 要点 3）。
4b. **✅ marker 边界错位（Task#2 实测发现，P1b 已验证可接受）**：pi 差分重绘下 OSC A mark 的 `registerMarker(0).line` 与最终文本行会错位（spinner 跳动/光标乱移）。P1b 真实流回放实测：以 aCount===1（user 消息首帧 A）的 marker 作 zoneStart，snapshot 到 cursor，**排除启动屏面板、干净捕获 user 问题 + assistant 3 要点**（见 §9 P1b 验证）。错位未阻碍有效 snapshot——宽范围 + spinner 过滤 + trim 收敛已足够；精确按消息切分留 P1d。
5. **✅ OSC 133 不区分 role（P1d spike 已确认有干净解，实现列 P1e）**：单看 mark 字符看不出 user/assistant，但 **A..B 之间夹该消息完整可见文本**（§6.2 实测），role 按 A 出现顺序定（§6.3 S1），resize 重发内容去重（S2）。当前仍占位 `observeInput` 输入按键直捕，P1e 切 A..B 提取（§6）。
6. **🟡 内存**：长会话 headless grid + scrollback 增长。session 退出 `dispose()`；长会话考虑定期 reset（与 pi 退出对齐）。
7. **🟡 客户端 `looksLikeJsonEnvelope`**：P0 遗留异味，应删除或收窄（至少不匹配 shell 可能输出的 `{"type":...}`）。独立小修，不阻塞 P1。
8. **🟡 xterm-headless 版本**：`^5.5.0`，前端 wterm 不依赖 xterm 无冲突。
9. **⚠️ xterm 同 ident 多 OSC handler 为 LIFO 提前返回（P1b 实测发现）**：`parser.registerOscHandler(133, h)` 多次注册时，后注册的 handler 若返回 `true` 会 **shadow 先注册的**——先注册的不执行。P1b spike 曾因此（旁路记录 mark 的第二 handler）导致内部 turn 状态机 handler 不运行、mode 恒 idle。结论：**业务 OSC 133 逻辑只注册一次**（terminal-observer 内部），外部如需旁路观测走 onFinalize/状态 getter，不要再 registerOscHandler(133)。

## 9. 实施节奏

延续需求简报 P0/P1 分法，P1 内部分阶段独立提交独立验证：

- **P1a（架构地基，最高风险先做）✅ 已交付**：引入 `@xterm/headless`，接线 `feed/resize/dispose`，删 `osc-parser.mjs`，`flushAgentReply` 改 grid snapshot。先用空闲计时模式跑通 A-005——验证 grid snapshot 对差分渲染有效。
- **P1b（turn 状态机）✅ 已交付**：接 `registerOscHandler(133)`，实现 turn 状态机 + 去重 + alt-screen 隔离。真实 pi 流验证 §8 验证点 1 通过。
  - **实现**（`terminal-observer.mjs`）：OSC 133 handler 内 `aCount` 计数（1=user 首帧 A 记 zoneStart，2=assistant 首帧 A，>=3 重绘）；任意 mark 重置 `OSC_DEBOUNCE_MS`(300ms) 去抖；去抖触发时若 `aCount<2`（assistant 未到）**抑制 premature finalize**，等 assistant；`aCount>=2` 则 `snapshotReply(zoneStart..cursor)` + `onFinalize`；alt-screen 期间 mark 忽略、去抖清除；`hasUserTurn` 闸门使 turn 已 finalize 后 resize 重发的 ABCABC 自然不重复录。
  - **server.mjs 接线**：`createObserver` 注入 `onFinalize→onReplyFinalize`（录 agent_reply + finalizeRecord + 清 hasUserMessage + setHasUserTurn(false)）；`flushUserMessage` 调 `setHasUserTurn(true)`；`observeOutput` 仅 feed + appendOutput（删 replyBuffer/idle 分支，idle 计时移入 terminal-observer）；exit/close 路径 `flushNow` 兜底；删 `oscDetected`/`replyBuffer`/`replyTimer`/`flushAgentReply`。
  - **验证**：① 合成测试 16/16 通过（S1 正常 finalize / S2 premature 抑制 / S3 resize 去重 / S4 alt-screen 隔离 / S5 idle 回退）；② Task#1 真实 pi 流回放：**1 次 `osc_debounce` finalize**，文本无 spinner 残片/无 ESC/无 OSC 码，排除启动屏面板，捕获 user 问题 + assistant 3 要点；③ server 端到端冒烟：idle 路径 grid snapshot 干净、前端纯字节无 JSON 噪声、resize 不崩、无异常事件。
- **P1c（回退与平滑切换）✅ 已交付**：`OSC_STALE_MS` 回退、`mode` 动态切换、普通 shell 回退用 grid snapshot。验证 A-007。
  - **实现**（`terminal-observer.mjs`）：新增 `staleMs`(5000, env `POC_OSC_STALE_MS`) + `staleTimer` + `armStale()`。OSC handler 每次 mark `armStale()`；超时 → `mode='idle'`（仅切模式，不 finalize turn，未 finalize 回复由后续 idle 计时/`flushNow` 兜底）；`flushNow`/`dispose` 清 stale 计时。`feed` 的 idle 路径条件 `mode==='idle'` 自然在 stale 切 idle 后接管。
  - **server.mjs 接线**：`OSC_STALE_MS` 常量 + 传入 observer `staleMs`。
  - **验证**：① 合成测试 15/15 通过（P1 stale 切 idle / P2 普通 shell 恒 idle 不回归 / P3 OSC→stale→idle→下个 turn idle 录 / P4 流式期间不误切）；② Task#1 真实 pi 流复跑：P1c 改动不破坏 P1b（仍 1 次 `osc_debounce` finalize、文本干净、stale=5000ms 未误切）；③ server 端到端冒烟：idle 路径 grid snapshot 干净、前端纯字节、stale env 传入不崩、无异常事件。
  - **已知限制**：idle 模式（普通 shell）zoneStart 为 null，snapshot 回退 baseY..cursor 抓整屏，多 turn 可能合录为 1 条 agent_reply。pi 的 OSC 模式由 zoneStart marker 精确定位（真实流验证排除启动屏）。shell 多 turn 精切留 P1d 边界切分。
- **P1d（role 标注 spike，独立）✅ 已交付**：验证 resize 是否真重发历史 mark（Task#1 已确认 idx=230 含 `ABCABC`），并设计 user/assistant 区分策略。
  - **发现（破局点）**：解析真实流发现 **A..B 之间夹该消息完整可见文本**（§6.2），role 难题从"grid 后切分"简化为"A..B 文本提取 + A 顺序定 role"。
  - **resize 风暴结构**：`ABCABC` = user(ABC)+assistant(ABC)，首组 A..B=user 文本、次组 A..B=assistant 文本（§6.3 S1 顺序固定）；resize 重发文本与已录相同（S2 内容匹配）；与上一 mark 间隔 19086ms（S3 时序窗）。
  - **策略**（§6.4，待 P1e 实现）：user 文本取 turn 内首个 A 的 A..B 文本（替代占位）；assistant 用 grid snapshot（P1b 已验证）；role 按 A 顺序（1=user,2=assistant）；resize 去重靠 P1b `hasUserTurn` 闸门 + S2 内容匹配。
  - **DECIDE-005 修正**（§6.5）：推翻"user 文本不可得"，pi 发 `A..B C` 包真实 user 文本，可从 A..B 提取。
  - **验证脚本**：`workplace/1.1/test/spike/p1d-resize-storm-analysis.mjs`（idx=230 结构）、`p1d-ab-extraction-analysis.mjs`（reply 阶段 A..B/B..C 文本规律）。
- **P1e（role 标注实现，独立，不阻塞）✅ 已交付**：据 P1d 策略实现——OSC handler 内捕获 A..B 文本，turn 内首 A=user，user 文本从 A..B grid range 提取。
  - **实现**（`terminal-observer.mjs`）：OSC A 时 `registerMarker(0)` 记 `pendingAMarker`；B 时读 `readGridRange(aLine, bLine)` = A..B 之间的消息可见文本；`aCount===1`（turn 内首 A）且有文本 → 存 `userTextFromOsc`（aCount>=2 的 A..B 为 assistant 首 A..B 空，不覆盖）。`commitFinalize` 传 `onFinalize({ assistantText, userTextFromOsc, role }, reason)`，`role='assistant'`(OSC)/`'mixed'`(idle)。`setHasUserTurn`/`dispose` 复位 `pendingAMarker`/`userTextFromOsc`。
  - **架构守一**：A..B 文本走 grid range（`readGridRange` 复用 snapshotReply 的 grid 读取），**不重解析字节流**——避免 tabby 双状态机覆辙。grid 在 B handler 触发时已含 A..B 之间写入的文本（B 前 print 路径已执行）。
  - **server.mjs 接线**：`onReplyFinalize(observer, payload, reason)` 拆 payload——`assistantText` 录 `agent_reply`（带 role）；`userTextFromOsc` 记 `user_text_osc` 校准日志（与 observeInput 按键直捕双源比对，不改 record 结构，P1f 决定是否切主源）。
  - **验证**：① 合成测试 9/9（E1 user A..B 捕获 / E2 idle role=mixed / E3 assistant 空 A..B 不覆盖 user / E4 resize 不污染）；② P1b 16/16 + P1c 15/15 回归不破坏；③ 真实 pi 流 6/6：`userTextFromOsc="用3个要点简短解释什么是递归，每点一行"`（干净，不含启动屏/assistant）、`role='assistant'`、assistantText 含 3 要点；④ server 冒烟：idle 路径 `role='mixed'`、shell 模式无 `user_text_osc`（无 OSC 正确）、无异常。
  - **范围限定**：P1e 交付 role 标注（OSC=assistant/idle=mixed）+ user 文本双源校准。**未做** user record 的 userText 主源切换（observeInput 仍主源，A..B 校准）与 user/assistant 合录切分（assistantText 仍含 user 问题+assistant 回复合录）——留 P1f（需 recorder 加 `updateUserText` API + grid 按 A..B 边界切分 assistant）。

每步独立提交、独立验证，避免一次性大改难定位回归。

## 10. 依赖与影响

- 新增依赖：`@xterm/headless@^5.5.0`
- 删除文件：`server/osc-parser.mjs`
- 改造文件：`server.mjs`（`createObserver`/`observeInput`/`observeOutput`/`flushAgentReply`/`bindPtyWebSocket`/`maybeHandleControlMessage`）、`server/text-utils.mjs`（缩减）、`app/components/TerminalWorkspace.tsx`（收窄/删除 `looksLikeJsonEnvelope`）
- 新增文件：`server/terminal-observer.mjs`
- 不变：`interaction-recorder.mjs` API、wterm 前端纯字节契约、`api.ts` HTTP 路径、`/api/records/*`

## 11. 开放问题（交接实现阶段）
- pi 多轮 assistant 重绘模型（§8 验证点 1）—— P1a 单测验证
- resize 是否重发历史 OSC mark（§6.3）—— P1d spike
- `OSC_STALE_MS`/`OSC_DEBOUNCE_MS`/`scrollback` 真实流调参 —— P1b/P1c
- headless grid 长 session 内存上限与 reset 策略 —— P1c
- `appendOutput` 原始字节是否仍需（搜索/重放依赖与否）—— P1a 确认消费者
