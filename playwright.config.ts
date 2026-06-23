import { defineConfig } from 'playwright/test';

export default defineConfig({
  testDir: 'test',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [['list']],
  use: {
    // 项目规则要求浏览器验证优先使用 Edge；没有可连接的 CDP Edge 时使用系统 Edge channel。
    channel: 'msedge',
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'edge',
      use: { channel: 'msedge' },
    },
  ],
});
