// v4-typed — типизированный клиент поверх `generated.ts` (OpenAPI).
//
// Использование:
//
//   import { api } from '@/lib/api'
//   const r = await api.GET('/api/v1/orders', { params: { query: { limit: 50 } } })
//   //                                                          ^^^^^^^ — type-checked
//
// Под капотом — `openapi-fetch` (~5 KB gzip). Каждый метод выводит
// response/body/params типы из generated.ts. Опечатки в URL,
// отсутствие обязательных полей, неверный enum — ловятся компилятором.
//
// Middleware:
//   • authMiddleware    — на каждом запросе подставляет Bearer из localStorage
//   • idemMiddleware    — для write-методов добавляет Idempotency-Key (UUID)
//   • authExpiredMiddleware — на 401 шлёт CustomEvent('restos:auth:expired')
//
// Это решает проблему «stale token» старой proxy-реализации, которая
// требовала пересоздавать клиент при смене токена.

import createClient, { type Middleware } from 'openapi-fetch'
import type { paths } from './generated'

export function getBaseURL(): string {
  // 1. Electron sidecar — точечный URL пробрасывается preload-скриптом.
  if (typeof window !== 'undefined' && (window as any).restosDesktop?.v4ApiUrl) {
    return (window as any).restosDesktop.v4ApiUrl as string
  }
  // 2. Явное переопределение через localStorage (для dev / диагностики).
  if (typeof localStorage !== 'undefined') {
    const stored = localStorage.getItem('restos-v4-api-url')
    if (stored) return stored
  }
  // 3. Браузер открыл SPA напрямую с http://<ip-кассы>:3001 — same-origin,
  //    API живёт на том же хосте/порту. Пустой baseURL → relative paths.
  //    Виттовский dev-сервер на :5173 при этом всё ещё ходит на :3001 (см. ниже).
  if (typeof window !== 'undefined' && window.location && window.location.protocol.startsWith('http')) {
    const { protocol, hostname, port } = window.location
    // Vite dev-server (5173/3000) → форсируем go-бэк на 3001.
    if (port === '5173' || port === '3000') {
      return `${protocol}//${hostname}:3001`
    }
    return '' // same-origin
  }
  // 4. SSR / node — fallback на дефолт.
  return 'http://127.0.0.1:3001'
}

const authMiddleware: Middleware = {
  async onRequest({ request }) {
    if (typeof localStorage !== 'undefined') {
      const tok = localStorage.getItem('restos-v4-token')
      if (tok) request.headers.set('Authorization', `Bearer ${tok}`)
    }
    return request
  },
}

const idemMiddleware: Middleware = {
  async onRequest({ request }) {
    const m = request.method.toUpperCase()
    if (m !== 'GET' && m !== 'HEAD' && !request.headers.has('Idempotency-Key')) {
      request.headers.set('Idempotency-Key', cryptoRandomUUID())
    }
    return request
  },
}

const authExpiredMiddleware: Middleware = {
  async onResponse({ response }) {
    if (response.status === 401 && typeof window !== 'undefined') {
      try {
        window.dispatchEvent(new CustomEvent('restos:auth:expired'))
      } catch {}
    }
    return response
  },
}

function cryptoRandomUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  const rnd = (Math.random() * 0xffffffff) >>> 0
  return `00000000-0000-4000-8000-${rnd.toString(16).padStart(12, '0')}`
}

export const api = createClient<paths>({ baseUrl: getBaseURL() })
api.use(authMiddleware)
api.use(idemMiddleware)
api.use(authExpiredMiddleware)

// Re-export типов, которые чаще всего нужны компонентам.
export type { paths, components } from './generated'
