/**
 * nterminal 终端协议。
 * 控制面用 JSON 信封（带 v=版本号），输出面用二进制帧（type=0x01 + 8B 大端 offset + payload），
 * 两端版本对不上或帧格式错位时通过抛错/返回 null 让上层显式处理。
 */

export const TERMINAL_PROTOCOL_VERSION = 1;
export const OUTPUT_FRAME_TYPE = 0x01;

/**
 * 把一段 PTY 输出编码为带偏移的二进制帧，offset 用 bigint 防止长会话溢出。
 * @param {number | bigint} startOffset
 * @param {Buffer | string | Uint8Array} payload
 */
export function encodeOutputFrame(startOffset, payload) {
  const normalizedOffset = typeof startOffset === 'bigint' ? startOffset : BigInt(startOffset);
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const frame = Buffer.allocUnsafe(9 + data.length);
  frame.writeUInt8(OUTPUT_FRAME_TYPE, 0);
  frame.writeBigUInt64BE(normalizedOffset, 1);
  data.copy(frame, 9);
  return frame;
}

/**
 * 解码二进制输出帧，type 不匹配或长度不足时抛错，附 code 便于上层区分错误类型。
 * @param {Buffer | Uint8Array} frame
 */
export function decodeOutputFrame(frame) {
  const buffer = Buffer.isBuffer(frame) ? frame : Buffer.from(frame);
  if (buffer.length < 9 || buffer.readUInt8(0) !== OUTPUT_FRAME_TYPE) {
    throw Object.assign(new Error('终端输出帧格式无效'), { code: 'INVALID_OUTPUT_FRAME' });
  }
  return {
    type: 'output',
    startOffset: buffer.readBigUInt64BE(1),
    payload: buffer.subarray(9),
  };
}

/**
 * 把控制面消息编码为带版本号的 JSON 字符串。
 * @param {Record<string, unknown>} message
 */
export function encodeEnvelope(message) {
  return JSON.stringify({ v: TERMINAL_PROTOCOL_VERSION, ...message });
}

/**
 * 解析控制面 JSON 字符串，版本不匹配抛错（带 code），解析失败返回 null。
 * @param {string} text
 */
export function parseControlEnvelope(text) {
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    return null;
  }
  if (!envelope || typeof envelope !== 'object') return null;
  if (envelope.v !== TERMINAL_PROTOCOL_VERSION) {
    throw Object.assign(new Error('终端协议版本不受支持'), { code: 'UNSUPPORTED_PROTOCOL_VERSION' });
  }
  return envelope;
}
