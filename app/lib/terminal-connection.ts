/**
 * 前端终端连接辅助。
 * 暴露连接状态枚举、视图绑定接口与 WebSocket URL 构造函数，组件层只关心协议不变的部分。
 */

export type TerminalConnectionState = 'connecting' | 'running' | 'ended' | 'closed' | 'error';

export interface TerminalViewBinding {
  onOutput: (text: string) => void;
  onState: (state: TerminalConnectionState, details?: unknown) => void;
  onError?: (message: string) => void;
}

// createTerminalWsUrl：按当前页面协议生成 ws/wss URL，lastOffset 让服务端可回填断线期间输出。
export function createTerminalWsUrl(tabId: string, lastOffset: bigint): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws/pty/${encodeURIComponent(tabId)}?lastOffset=${lastOffset.toString()}`;
}
