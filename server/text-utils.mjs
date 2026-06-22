/**
 * Text utilities for server side
 */
import xtermHeadless from '@xterm/headless';
const { Terminal } = xtermHeadless;

const SPINNER_RE = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g;

/**
 * Strip ANSI escape sequences from a string
 */
export function stripAnsi(input) {
  return input
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][A-Za-z0-9]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\r/g, '\n');
}

/**
 * Normalize visible text by stripping ANSI, trimming trailing spaces, removing empty lines
 */
export function normalizeVisibleText(input) {
  return stripAnsi(input)
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .filter((line) => line.trim().length > 0)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Create a preview string with truncation
 * @param {string} text - Input text
 * @param {'user' | 'output'} kind - Type of text for threshold selection
 * @returns {string} Truncated preview
 */
export function makePreview(text, kind) {
  const threshold = kind === 'user' ? 200 : 500;
  const visible = normalizeVisibleText(text);
  if (visible.length <= threshold) {
    return visible;
  }
  return visible.slice(0, threshold) + '...';
}

/**
 * 合并连续重复行（TUI 重绘/空行残留收敛）。
 */
/**
 * 通用"渐进行"合并：在文本尾部 tailLines 行内，折叠前缀链与重复行。
 * 不依赖任何 TUI 协议——只基于"前一行是后一行的真前缀"这一文本关系。
 *
 * 典型场景：流式 TUI（pi 等）把每个 streaming chunk 写到新行而非覆盖同
 * 一行，导致 grid viewport 末段出现 "你好" → "你好！" → "你好！有什么"
 * → ... 的渐进行；本函数把它们折叠为最终行 "你好！有什么我可以帮你的吗？"。
 *
 * 规则（仅作用于 tailLines 范围内的行，保护上方对话历史）：
 *   - 完全相同：去重
 *   - 真前缀：保留更长的（覆盖更新）
 *   - 空行不参与前缀判定（避免空行吞掉非空内容）
 *   - 仅当合并后行数 < 合并前行数才采用结果（保护性 no-op）
 */
export function collapseProgressiveLinesAtTail(text, tailLines = 12) {
  if (!text || typeof text !== 'string') return text || '';
  const lines = text.split('\n');
  if (lines.length <= 1) return text;
  const splitAt = Math.max(0, lines.length - tailLines);
  const head = lines.slice(0, splitAt);
  const tail = lines.slice(splitAt);
  const out = [];
  for (const cur of tail) {
    if (out.length === 0) { out.push(cur); continue; }
    const last = out[out.length - 1];
    if (last === cur) continue; // 完全相同
    if (isTruePrefix(last, cur)) { out[out.length - 1] = cur; continue; } // cur 是 last 的更长更新
    if (isTruePrefix(cur, last)) continue; // last 已是 cur 的前缀，跳过 cur
    out.push(cur);
  }
  if (out.length >= tail.length) return text; // 保护性 no-op
  return [...head, ...out].join('\n');
}

function isTruePrefix(a, b) {
  if (!a || !b) return false; // 空行不参与前缀合并
  if (a.length >= b.length) return false;
  return b.startsWith(a);
}

function collapseRepeatedLines(text, maxConsecutive = 2) {
  const lines = text.split('\n');
  const out = [];
  let lastNonEmpty = null;
  let repeat = 0;
  for (const line of lines) {
    if (line.trim() === '') {
      // 空行：最多保留 1 个，且不夹在重复之间
      if (out.length > 0 && out[out.length - 1] !== '') {
        out.push('');
      }
      lastNonEmpty = null;
      repeat = 0;
      continue;
    }
    if (line === lastNonEmpty) {
      repeat += 1;
      if (repeat < maxConsecutive) out.push(line);
      continue;
    }
    lastNonEmpty = line;
    repeat = 0;
    out.push(line);
  }
  return out.join('\n').replace(/\n+$/, '').trim();
}

/**
 * 把原始 PTY 字节流重放到 headless xterm grid，再读回最终可见文本。
 * 与 terminal-observer.mjs 同源思路：grid 正确解释光标移动/覆盖/alt-screen，
 * 因此 TUI 重绘残留的旧字符被新字符覆盖，不会出现 stripAnsi 那种叠加重复。
 *
 * 读全量行（含 scrollback），过滤 spinner + 收敛连续重复/空行。
 * 大输出（>2MB）直接回退 normalizeVisibleText，避免单次重放过重。
 */
export async function renderOutputClean(rawOutput, { cols = 80, rows = 24 } = {}) {
  if (!rawOutput) return '';
  if (typeof rawOutput !== 'string') return '';
  if (rawOutput.length > 2_000_000) {
    return normalizeVisibleText(rawOutput);
  }
  let term;
  try {
    term = new Terminal({
      cols: Math.max(1, cols),
      rows: Math.max(1, rows),
      scrollback: 5000,
      convertEol: false,
      allowProposedApi: true,
    });
  } catch {
    return normalizeVisibleText(rawOutput);
  }
  try {
    // @xterm/headless 是异步解析（callback 触发时 grid 才更新完），
    // 必须 await 回调才能读到正确内容
    await new Promise((resolve, reject) => {
      try {
        term.write(rawOutput, () => resolve());
      } catch (err) {
        reject(err);
      }
    });
  } catch {
    try { term.dispose(); } catch { /* ignore */ }
    return normalizeVisibleText(rawOutput);
  }
  let text;
  try {
    const buf = term.buffer.active;
    const len = buf.length;
    const lines = [];
    for (let y = 0; y < len; y++) {
      const ln = buf.getLine(y);
      if (ln) lines.push(ln.translateToString(true));
    }
    text = lines
      .join('\n')
      .replace(SPINNER_RE, '')
      .replace(/\n{3,}/g, '\n\n');
  } catch {
    text = normalizeVisibleText(rawOutput);
  } finally {
    try { term.dispose(); } catch { /* ignore */ }
  }
  return collapseProgressiveLinesAtTail(collapseRepeatedLines(text));
}