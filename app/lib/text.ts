/**
 * Text utilities for client side
 */

/**
 * Strip ANSI escape sequences from a string
 */
export function stripAnsi(input: string): string {
  return input
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][A-Za-z0-9]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\r/g, '\n');
}

/**
 * Create a preview string with truncation
 */
export function makePreview(text: string, kind: 'user' | 'output'): string {
  const threshold = kind === 'user' ? 200 : 500;
  const visible = stripAnsi(text)
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .filter((line) => line.trim().length > 0)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (visible.length <= threshold) {
    return visible;
  }
  return visible.slice(0, threshold) + '...';
}

/**
 * Render text safely as a React element (text node, no HTML execution)
 */
export function renderSafeText(text: string): React.ReactNode {
  // This is a placeholder; actual implementation will be in T-008
  // For now, return a span with white-space: pre-wrap
  return text;
}