import { defineConfig, devices } from '@playwright/test';

const PORT_API = 3002;
const PORT_WEB = 3000;
const baseURL = `http://localhost:${PORT_WEB}`;
const apiURL = `http://localhost:${PORT_API}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false, // these tests share API+DB state
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  timeout: 30_000,
  expect: { timeout: 5_000 },

  use: {
    baseURL,
    trace: 'retain-on-failure',
    actionTimeout: 5_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Spawn both servers if they're not already up. reuseExistingServer keeps
  // local dev fast; CI starts fresh.
  webServer: [
    {
      command: 'pnpm --filter @agentbase/api run dev',
      url: `${apiURL}/health`,
      cwd: '../..',
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        // CI is responsible for providing DATABASE_URL and REDIS_URL via job env;
        // local dev uses apps/api/.env
        ...process.env,
      },
    },
    {
      command: 'pnpm --filter @agentbase/web run dev',
      url: baseURL,
      cwd: '../..',
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
