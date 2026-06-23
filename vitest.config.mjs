import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 后端和 smoke 测试默认使用 Node；需要 DOM 的组件测试在文件内声明 jsdom。
    environment: 'node',
    include: ['test/**/*.{test,spec}.{js,mjs,ts,tsx}'],
    exclude: ['test/e2e/**', 'test/performance/**'],
  },
});
