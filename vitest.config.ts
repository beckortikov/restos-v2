import { defineConfig } from 'vitest/config'
import path from 'path'

// Vitest config for v4 unit tests. Отдельно от vite.config.ts чтобы не
// тянуть VitePWA в тестовый ран (PWA плагину не нужен node environment).
//
// `@` alias mirrors vite.config.ts so `@/lib/...` импорты работают в тестах.
//
// happy-dom вместо jsdom: быстрее в 2-3 раза, для нашего объёма (несколько
// React-тестов через @testing-library/react) разницы в поведении нет.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    // jsdom even though slower — happy-dom 20's localStorage is a Proxy
    // that breaks при синхронном module-load `lib/api/v4-typed.ts:29`
    // (`localStorage.getItem(...)` throws "is not a function" хотя typeof
    // localStorage !== 'undefined' проходит).
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    globals: false,
    include: [
      'lib/**/*.test.{ts,tsx}',
      'components/**/*.test.{ts,tsx}',
      'hooks/**/*.test.{ts,tsx}',
    ],
    // Существующие Playwright e2e специ (tests/*.spec.ts) запускаются через
    // `playwright test`, не vitest. node_modules — обязательно (там тоже
    // встречаются .test.ts из вендоров).
    exclude: [
      '**/node_modules/**',
      'dist/**',
      'desktop/**',
      'tests/**',
    ],
    testTimeout: 10_000,
  },
})
