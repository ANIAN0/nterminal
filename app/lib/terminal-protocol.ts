/**
 * 前端终端协议定义。
 * 与 server/terminal-protocol.mjs 保持同一协议版本号；前端只解析控制面信封和解码二进制输出帧。
 */

export const TERMINAL_PROTOCOL_VERSION = 1;
export const OUTPUT_FRAME_TYPE = 0x01;

export interface OutputFrame {
  startOffset: bigint;
  payload: Uint8Array;
}

// decodeOutputFrame：解码 type=0x01 的二进制输出帧，offset 用 BigInt 防止长会话溢出。
export function decodeOutputFrame(data: ArrayBuffer): OutputFrame {
  const view = new DataView(data);
  if (view.byteLength < 9 || view.getUint8(0) !== OUTPUT_FRAME_TYPE) {
    throw new Error('终端输出帧格式无效');
  }
  return {
    startOffset: view.getBigUint64(1, false),
    payload: new Uint8Array(data, 9),
  };
}

// encodeResize：把列行数编码为带 v= 版本号的控制面 JSON 信封。
export function encodeResize(cols: number, rows: number): string {
  return JSON.stringify({ v: TERMINAL_PROTOCOL_VERSION, type: 'resize', cols, rows });
}

// parseEnvelope：解析控制面 JSON 字符串，解析失败返回 null；版本不匹配由调用方决定是否抛错。
export function parseEnvelope(text: string): { v?: number; type?: string; [key: string]: unknown } | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}
