/**
 * terminal-observer.mjs
 *
 * 服务端单一 VT 状态机：用 @xterm/headless 维护一个真实终端 grid，
 * 旁路消费 PTY 输出字节流，用于还原差分渲染 TUI（如 pi）的最终可见文本。
 *
 * 架构对齐 Warp：PTY 字节同时喂渲染层（前端 wterm）和本 grid（旁路记录）。
 * OSC 133 等 VT 序列由 headless 内部状态机解析；本模块只在其扩展点挂业务逻辑。
 *
 * P1a：grid 维护 + snapshotReply（可见文本还原）。✅ 已交付
 * P1b（本版）：turn 状态机 + OSC 去重 + alt-screen 隔离。
 *   - registerOscHandler(133) 挂在维护 grid 的同一 parser 上（消除双扫描，跨 chunk 免费）
 *   - turn 状态机：A 记 zoneStart marker + aCount 计数；任意 OSC mark 重置 finalize 去抖；
 *     去抖触发 → snapshot(zoneStart..cursor) → onFinalize 回调（server 侧录 agent_reply + finishTurn）
 *   - premature 抑制：user 消息的 C 在 LLM 首 token 前到达会触发短去抖(300ms) premature finalize，
 *     用 aCount<2（assistant 首帧 A 未到）判定为 user-only 渲染 → 抑制不录，等 assistant
 *   - resize 重绘去重：turn 已 finalize 后 hasUserTurn=false，后续 resize 重发的 ABC 自然被闸门忽略
 *   - alt-screen 隔离：进 alt-screen（vim/less）期间 mark 忽略、去抖清除
 *   - 普通 shell 回退：mode 恒 'idle'（无 OSC），idle 计时器路径工作（P1a 行为保留）
 *
 * 实测依据（Task#1/Task#2）：
 *   - pi OSC 133 协议：首帧 ABC + 后续帧 BC（无 A）；启动屏无 OSC；resize 重发完整 ABC
 *   - .write() 异步：grid 解析在 setTimeout(0) 分片完成，feed() 用 cb 串行保证 apply 顺序
 *   - allowProposedApi: true 必设（term.buffer 为 proposed API）
 *   - spinner 过滤：pi 流式时 braille spinner [⠋-⠏] 与回复同区
 *   - marker 边界错位（Task#2 4b）：A mark 行与最终文本行会错位，故 snapshot 取
 *     zoneStart（首条 user 消息 A marker）到 cursor 的宽范围，trim 收敛；精确切分留 P1d
 */
import xtermHeadless from '@xterm/headless';
const { Terminal } = xtermHeadless;

const SPINNER_RE = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g;

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_SCROLLBACK = 5000;
const DEFAULT_DEBOUNCE_MS = 300;   // OSC mark 静默多久 → finalize（pi 流式帧间隔远小于此）
const DEFAULT_IDLE_MS = 1800;      // 非 OSC shell 空闲切片（沿用 server REPLY_IDLE_MS）
const DEFAULT_STALE_MS = 5000;     // OSC mark 静默多久 → 认为已退出 OSC 源（pi 退回 shell），mode 回 idle

/**
 * @param {object} opts
 * @param {number} [opts.cols]
 * @param {number} [opts.rows]
 * @param {(payload:object, reason:string)=>void} [opts.onFinalize]  回复 finalize 回调
 *   payload = { assistantText, userTextFromOsc, role }
 *   - assistantText: grid snapshot 还原的回复可见文本（user 问题 + assistant 回复合录，idle 模式），
 *     或仅 assistant 区（OSC 模式，zoneStart=user A 之后）。P1e 暂仍合录整段，role 切分留 P1f。
 *   - userTextFromOsc: OSC A..B grid range 捕获的 user 文本（P1e，pi 渲染的真实 user 文本），
 *     OSC 模式且 aInTurn===1 的 A..B 有文本时填；否则 null。
 *   - role: 'assistant'（OSC 模式）/ 'mixed'（idle 模式合录）
 * @param {number} [opts.debounceMs]
 * @param {number} [opts.idleMs]
 * @param {number} [opts.staleMs]  OSC mark 静默超时 → mode 回 idle（pi 退回 shell）
 */
export function createTerminalObserver({
  cols = DEFAULT_COLS,
  rows = DEFAULT_ROWS,
  onFinalize = () => {},
  debounceMs = DEFAULT_DEBOUNCE_MS,
  idleMs = DEFAULT_IDLE_MS,
  staleMs = DEFAULT_STALE_MS,
} = {}) {
  const term = new Terminal({
    cols,
    rows,
    scrollback: DEFAULT_SCROLLBACK,
    convertEol: false,
    allowProposedApi: true,
  });

  // —— VT / grid 状态 ——
  let writeChain = Promise.resolve();
  let inAltScreen = false;

  // —— turn 状态机 ——
  // mode: 'idle'(普通 shell，无 OSC) | 'osc'(见过 OSC 133，pi 等结构化 TUI)
  // turnState: 'IDLE' | 'IN_REPLY'
  // aCount: 当前 user turn 内见过的 A mark 数（turn-scoped，setHasUserTurn 复位）
  //   1=user 消息首帧 A，2=assistant 消息首帧 A，>=3=重绘（user/assistant 视奇偶）
  // zoneStartMarker: aCount===1 时 registerMarker(0)，对话区起点（宽范围 snapshot 下界）
  // P1e：user A..B 文本捕获
  //   pendingAMarker: 收到 A 后 registerMarker(0)，等配对 B 时读 A..B grid range
  //   userTextFromOsc: turn 内 aInTurn===1 的 A..B 捕获的 user 文本（pi 渲染的真实文本）
  let mode = 'idle';
  let turnState = 'IDLE';
  let aCount = 0;
  let zoneStartMarker = null;
  let hasUserTurn = false;
  let pendingAMarker = null;
  let userTextFromOsc = null;

  let finalizeDebounce = null;   // OSC 静默 finalize 计时
  let idleTimer = null;          // 非 OSC shell 空闲 finalize 计时
  let staleTimer = null;         // OSC mark 静默 → mode 回 idle 计时（P1c）

  function clearDebounce() {
    if (finalizeDebounce) { clearTimeout(finalizeDebounce); finalizeDebounce = null; }
  }
  function clearIdle() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  }
  function clearStale() {
    if (staleTimer) { clearTimeout(staleTimer); staleTimer = null; }
  }

  /**
   * 重置 OSC stale 计时（P1c）。OSC_STALE_MS 内无新 mark → 认为已退出 OSC 源
   * （pi 退回 shell / TUI 崩溃 / shell 接管），mode 回 idle。
   * 仅切模式，不 finalize turn（若有未 finalize 的回复，由后续 idle 计时或 flushNow 兜底）。
   */
  function armStale() {
    clearStale();
    staleTimer = setTimeout(() => {
      staleTimer = null;
      if (mode !== 'osc') return;
      mode = 'idle';
      // mode 切 idle 后，若仍有未 finalize 的 user turn，让 idle 计时接管（下个 feed 触发）
      // 不在此立即 arm idle——避免在无新输出时凭空 finalize。
    }, staleMs);
  }

  function syncAltScreen() {
    try {
      const now = term.buffer.active.type === 'alternate';
      if (now !== inAltScreen) {
        inAltScreen = now;
        if (now) clearDebounce();   // 进 alt-screen：挂起去抖（vim/less 不录）
      }
    } catch { /* buffer 不可用，忽略 */ }
  }

  /**
   * 从 zoneStart marker 到光标行读 grid，过滤 spinner，返回可见文本。
   * marker age-out（line<0）或越界 → 回退 baseY（viewport 顶）。
   */
  function snapshotReply() {
    return readGridRange(zoneStartMarker?.line, null);
  }

  /**
   * 读 grid [startLine..endLine]（endLine 省略→光标行），过滤 spinner，返回可见文本。
   * P1e：A..B grid range 读取复用此函数。
   */
  function readGridRange(startLine, endLine) {
    const buf = term.buffer.active;
    const end = endLine != null ? endLine : (buf.baseY + buf.cursorY);
    let start = startLine != null ? startLine : buf.baseY;
    if (start < 0 || start > end) start = buf.baseY;
    const lines = [];
    for (let y = start; y <= end; y++) {
      const ln = buf.getLine(y);
      if (ln) lines.push(ln.translateToString(true));
    }
    return lines
      .join('\n')
      .replace(SPINNER_RE, '')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\n+$/, '')
      .trim();
  }

  /**
   * 真正 finalize 一个回复：snapshot + onFinalize + 复位 turn 状态。
   * 仅在 hasUserTurn 时被调用（debounce/idle/flushNow 均在 hasUserTurn 下 arm）。
   * OSC 模式 turnState===IN_REPLY 时 zoneStart 给精确范围；idle 模式 zoneStart 为 null
   * → snapshotReply 回退 baseY..cursor（P1a 宽范围行为）。
   * P1e：payload 含 userTextFromOsc（A..B 捕获的 user 文本）与 role。
   */
  function commitFinalize(reason) {
    clearDebounce();
    clearIdle();
    let assistantText = '';
    try { assistantText = snapshotReply(); }
    catch (err) { assistantText = ''; /* snapshot 异常不阻断 finalize */ }
    const payload = {
      assistantText,
      userTextFromOsc,
      role: mode === 'osc' ? 'assistant' : 'mixed',
    };
    // 复位 turn 状态（mode 保留，P1c 负责 stale 回退）
    turnState = 'IDLE';
    aCount = 0;
    if (zoneStartMarker) { try { zoneStartMarker.dispose(); } catch {} zoneStartMarker = null; }
    if (pendingAMarker) { try { pendingAMarker.dispose(); } catch {} pendingAMarker = null; }
    userTextFromOsc = null;
    if (hasUserTurn) {
      // 交还 server 侧录 agent_reply + finishTurn + 清 hasUserMessage
      try { onFinalize(payload, reason); } catch { /* server 侧自有 try/catch，兜底 */ }
    }
  }

  /**
   * OSC 133 dispatch。data 形如 "A"/"B"/"C"（pi 不发 D）。
   * 任意 mark 都视为 OSC 活动 → 重置 finalize 去抖。
   */
  term.parser.registerOscHandler(133, (data) => {
    syncAltScreen();
    if (inAltScreen) return true;          // alt-screen 期间 mark 忽略

    const mark = data && data[0];
    mode = 'osc';                          // 见到 OSC → 切 OSC 模式
    armStale();                            // P1c：重置 stale 计时，超时则 mode 回 idle
    clearIdle();                           // OSC 接管计时，清 idle 兜底

    if (mark === 'A') {
      aCount += 1;
      if (aCount === 1) {
        // 首条消息（user）首帧：记对话区起点
        try { zoneStartMarker = term.registerMarker(0); } catch { zoneStartMarker = null; }
        turnState = 'IN_REPLY';
      }
      // aCount>=2：assistant 首帧 A（或重绘 A）—— 不移动 zoneStart（保留宽范围起点）
      // P1e：每个 A 都 registerMarker(0) 待配对 B，读 A..B grid range 提取该消息文本
      if (pendingAMarker) { try { pendingAMarker.dispose(); } catch {} }
      try { pendingAMarker = term.registerMarker(0); } catch { pendingAMarker = null; }
    } else if (mark === 'B' && pendingAMarker) {
      // P1e：A..B 之间文本已写入 grid，读 pendingAMarker.line..cursor 行 = 该消息可见文本
      const aLine = pendingAMarker.line;
      const buf = term.buffer.active;
      const bLine = buf.baseY + buf.cursorY;
      try {
        const abText = readGridRange(aLine, bLine);
        if (aCount === 1 && abText) {
          // turn 内首条 A..B = user 文本（pi 渲染的真实 user 消息，P1d §6.2）
          userTextFromOsc = abText;
        }
        // aCount>=2 的 A..B：assistant 首 A..B 为空（还没生成），重绘 A..B = assistant 完整文本。
        // P1e 暂不单独存 assistant A..B（assistant 走 grid snapshot zoneStart..cursor），留 P1f 切分。
      } catch { /* grid range 读取失败忽略 */ }
      try { pendingAMarker.dispose(); } catch {}
      pendingAMarker = null;
    } else if (mark === 'C') {
      // C 收尾：未配对的 A 丢弃
      if (pendingAMarker) { try { pendingAMarker.dispose(); } catch {} pendingAMarker = null; }
    }

    // 任意 OSC mark 重置 finalize 去抖（pi 流式每帧 BC 都重置，流结束静默 debounceMs 后 finalize）
    if (hasUserTurn && turnState === 'IN_REPLY') {
      clearDebounce();
      finalizeDebounce = setTimeout(() => {
        finalizeDebounce = null;
        // premature 抑制：只见过 user 消息（aCount<2），assistant 未开始 → 不录，等 assistant
        if (aCount < 2) {
          // 保留 turnState/aCount/zoneStart，等 assistant 首帧 A 把 aCount 推到 2
          return;
        }
        commitFinalize('osc_debounce');
      }, debounceMs);
    }
    return true;
  });

  /**
   * 喂 PTY 输出字节到 grid。返回 promise，resolve 时该 chunk 已 apply。
   */
  function feed(data) {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
    writeChain = writeChain.then(() => new Promise((resolve) => {
      term.write(buf, () => {
        syncAltScreen();
        // 非 OSC shell 回退：有 user turn 但从未见 OSC → idle 计时器切片（P1a 行为）
        if (hasUserTurn && mode === 'idle' && !inAltScreen) {
          clearIdle();
          idleTimer = setTimeout(() => {
            idleTimer = null;
            commitFinalize('idle');
          }, idleMs);
        }
        resolve();
      });
    }));
    return writeChain;
  }

  /** user Enter 时调用（server flushUserMessage）：开新 turn，复位 OSC 计数。 */
  function setHasUserTurn(v) {
    hasUserTurn = v;
    if (v) {
      // 新 user turn：复位上一轮残留（aCount/zoneStart/pendingA/userTextFromOsc），但不清 mode
      clearDebounce();
      turnState = 'IDLE';
      aCount = 0;
      if (zoneStartMarker) { try { zoneStartMarker.dispose(); } catch {} zoneStartMarker = null; }
      if (pendingAMarker) { try { pendingAMarker.dispose(); } catch {} pendingAMarker = null; }
      userTextFromOsc = null;
    }
  }

  /** 强制 finalize（ws close / pty exit 兜底，= Warp TerminalModel::exit）。 */
  function flushNow(reason) {
    clearStale();
    if (hasUserTurn && turnState === 'IN_REPLY') {
      commitFinalize(reason);
    }
  }

  function resize(c, r) {
    try { term.resize(c, r); } catch (err) { throw err; }
  }

  function dispose() {
    clearDebounce();
    clearIdle();
    clearStale();
    if (zoneStartMarker) { try { zoneStartMarker.dispose(); } catch {} zoneStartMarker = null; }
    if (pendingAMarker) { try { pendingAMarker.dispose(); } catch {} pendingAMarker = null; }
    userTextFromOsc = null;
    try { term.dispose(); } catch { /* ignore */ }
  }

  return {
    feed,
    setHasUserTurn,
    flushNow,
    resize,
    dispose,
    snapshotReply,
    get mode() { return mode; },
    get turnState() { return turnState; },
    get inAltScreen() { return inAltScreen; },
    /** 暴露调试用 */
    _registerOscHandler(ident, handler) { return term.parser.registerOscHandler(ident, handler); },
    get _buffer() { return term.buffer.active; },
  };
}
