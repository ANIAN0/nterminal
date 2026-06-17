/**
 * OSC 133 (Semantic Prompts) streaming parser.
 *
 * Scans a byte stream for OSC 133 marks: A (prompt start), B (command start),
 * C (output end), D (exit code). Handles cross-chunk splits.
 *
 * Usage:
 *   const p = createOsc133Parser();
 *   const events = p.feed(chunk);
 *   for (const e of events) {
 *     if (e.type === 'mark') { ... }
 *     if (e.type === 'text') { ... }
 *   }
 *
 * Events:
 *   { type: 'mark', mark: 'A'|'B'|'C'|'D', payload?: string }
 *     A = prompt start (zone begin)
 *     B = command start (prompt end)
 *     C = output end (zone final)
 *     D = exit code
 *   { type: 'text', text: string }
 *     Visible text since last mark (or since start / previous text).
 */

const BEL = 0x07;
const ESC = 0x1b;

export function createOsc133Parser() {
  let buffer = '';

  function processBuffer() {
    const events = [];
    let i = 0;

    while (i < buffer.length) {
      // Scan for ESC followed by ] to start an OSC sequence
      const escIdx = buffer.indexOf(ESC, i);
      if (escIdx === -1) {
        // No more ESC in buffer. Emit remaining text and wait for more input.
        if (i < buffer.length) {
          const tail = buffer.slice(i);
          if (tail) events.push({ type: 'text', text: tail });
          buffer = '';
        }
        break;
      }

      // Check if this ESC starts OSC 133
      const afterEsc = buffer.slice(escIdx + 1);
      if (!afterEsc.startsWith(']133;')) {
        // Not OSC 133. Emit text up to this ESC (it might be a lone ESC).
        if (escIdx > i) {
          const text = buffer.slice(i, escIdx);
          if (text) events.push({ type: 'text', text });
        }
        // Check if this ESC is part of a multi-byte sequence (like \x1b\\ for ST)
        // For now, emit the ESC as text and skip it.
        events.push({ type: 'text', text: '\x1b' });
        i = escIdx + 1;
        continue;
      }

      // We found "\x1b]133;". Now find the mark letter and terminator.
      const markStart = escIdx + 1 + 4; // after "]133;"
      if (markStart >= buffer.length) {
        // Not enough data yet (mark letter might be in next chunk). Hold.
        break;
      }

      const markChar = buffer[markStart];
      if ('ABCD'.indexOf(markChar) === -1) {
        // Not a valid OSC 133 mark. Emit text up to this ESC and skip.
        if (escIdx > i) {
          events.push({ type: 'text', text: buffer.slice(i, escIdx) });
        }
        events.push({ type: 'text', text: '\x1b]133;' });
        i = markStart;
        continue;
      }

      // Look for terminator: BEL (0x07) or ST (\x1b\)
      const termStart = markStart + 1;
      let termEnd = -1;
      let termLen = 0;

      // For D mark, there may be a payload: \x1b]133;D;EXITCODE\x07
      // Scan from termStart for BEL or \x1b\\
      for (let j = termStart; j < buffer.length; j++) {
        if (buffer.charCodeAt(j) === BEL) {
          termEnd = j;
          termLen = 1;
          break;
        }
        if (buffer.charCodeAt(j) === ESC && j + 1 < buffer.length && buffer[j + 1] === '\\') {
          termEnd = j;
          termLen = 2;
          break;
        }
      }

      if (termEnd === -1) {
        // Terminator not found. Could be split across chunks.
        // Hold back from the ESC position.
        break;
      }

      // Emit any text before the OSC sequence
      if (escIdx > i) {
        const text = buffer.slice(i, escIdx);
        if (text) events.push({ type: 'text', text });
      }

      // Extract payload (for D mark: between mark letter and terminator)
      let payload;
      if (markChar === 'D') {
        const payloadStr = buffer.slice(termStart, termEnd);
        payload = payloadStr || undefined;
      }

      events.push({ type: 'mark', mark: markChar, payload });
      i = termEnd + termLen;
    }

    return events;
  }

  return {
    feed(chunk) {
      buffer += chunk;
      return processBuffer();
    },

    reset() {
      buffer = '';
    },
  };
}
