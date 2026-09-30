import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  timeout: 60_000,
  expect: { timeout: 12_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
    viewport: { width: 1440, height: 1024 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
    permissions: ['camera', 'microphone'],
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1024 } },
    },
  ],
});
