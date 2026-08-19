import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'
import { readFileSync } from 'node:fs'

// Версия ПОС — из desktop/package.json (единственный бампаемый источник).
// Инжектим в бандл (__APP_VERSION__), чтобы версия показывалась и в Electron,
// и в LAN-браузере (там window.restosDesktop нет).
const appVersion: string = JSON.parse(
  readFileSync(path.resolve(__dirname, 'desktop/package.json'), 'utf-8'),
).version

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  // Electron грузит index.html через file:// — относительные пути обязательны,
  // иначе `/assets/...` уйдёт в корень файловой системы.
  // Для web-сборки (если когда-то понадобится) можно переопределить через env.
  base: process.env.VITE_BASE_PATH || './',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      strategies: 'generateSW',
      manifest: false,
      injectRegister: null,
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,woff2,ico,webp,jpg,jpeg}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/rest\//, /^\/auth\//, /^\/api\//],
        cleanupOutdatedCaches: true,
        skipWaiting: true,
        clientsClaim: true,
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/.*\.supabase\.co\/storage\/.*/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'supabase-storage',
              expiration: { maxEntries: 50, maxAgeSeconds: 7 * 24 * 60 * 60 },
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
    dedupe: ['react', 'react-dom'],
  },
  server: {
    port: 3000,
    host: '0.0.0.0',
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        // ⚠️ Группы 'charts' здесь БОЛЬШЕ НЕТ — и возвращать её нельзя.
        //
        // Пока recharts+d3 сводились в чанк 'charts', rolldown укладывал туда же
        // CJS-обёртку react-ядра (manualChunks на CJS-модулях он не соблюдает —
        // проверено: правило возвращает 'react', модуль всё равно оказывается в
        // 'charts'). React нужен всем, поэтому стартовый граф тянул весь чанк
        // целиком: 439 КБ recharts парсились ради PIN-экрана, где графиков нет.
        //
        // Без группы recharts сам уезжает в общий чанк ленивых страниц финансов
        // и аналитики — дублирования нет, стартовый граф легче на 439 КБ.
        // Сопоставляем по ИМЕНИ ПАКЕТА, а не по подстроке в пути: старые правила
        // на includes() перехватывали друг друга (node_modules/recharts/... ловилось
        // раньше, чем react-модуль доходил до своего правила).
        manualChunks: (id) => {
          const p = id.replace(/\\/g, '/')
          if (!p.includes('node_modules')) return
          const m = p.match(/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/)
          const pkg = m?.[1]
          if (!pkg) return
          // React-рантайм — первым правилом: он фундамент для всех остальных.
          if (pkg === 'react' || pkg === 'react-dom' || pkg === 'scheduler'
            || pkg === 'react-is' || pkg === 'use-sync-external-store') return 'react'
          if (pkg === 'xlsx') return 'xlsx'
          if (pkg === 'react-router' || pkg === 'react-router-dom') return 'router'
          if (pkg === 'lucide-react') return 'icons'
          if (pkg.startsWith('@radix-ui') || pkg === 'vaul') return 'ui'
          if (pkg.startsWith('@sentry')) return 'sentry'
        },
      },
    },
  },
})
