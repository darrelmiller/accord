import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './browser-tests',
  workers: 1,
  timeout: 30_000,
  reporter: 'list',
  use: {
    channel: process.env.ACCORD_BROWSER_CHANNEL || 'msedge',
    headless: true,
    viewport: { width: 1280, height: 900 },
    trace: 'retain-on-failure'
  }
});
