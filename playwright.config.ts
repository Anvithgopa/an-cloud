import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:3199',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    },
  ],
  webServer: {
    command: 'PORT=3199 HOST=127.0.0.1 STORAGE_ROOT=.local-cloud-e2e REQUIRE_MOUNT_CHECK=false npm run start',
    url: 'http://127.0.0.1:3199/api/v1/health',
    reuseExistingServer: false,
    timeout: 15000,
  },
});
