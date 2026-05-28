import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  timeout: 60000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:3000',
    headless: true,
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run dev',
    port: 3000,
    reuseExistingServer: true,
    timeout: 60000,
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
      // Основной smoke-набор — без perf-тестов (они медленные и требуют
      // запущенного desktop:standalone на :3001).
      testIgnore: /tests\/perf\//,
    },
    {
      name: 'perf',
      testDir: './tests/perf',
      timeout: 120_000, // seed 200 заказов в PGlite не быстрый
      use: { browserName: 'chromium' },
    },
  ],
})
