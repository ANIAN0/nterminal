/**
 * Text utilities for server side
 */

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