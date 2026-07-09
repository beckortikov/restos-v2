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
import { randomId } from '../random-id'

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
  // 3. Браузер открыл SPA напрямую с http://<ip-кассы>:3002 — same-origin,
  //    API живёт на том же хосте/порту. Пустой baseURL → relative paths.
  //    Виттовский dev-сервер на :5173 при этом всё ещё ходит на :3002 (см. ниже).
  if (typeof window !== 'undefined' && window.location && window.location.protocol.startsWith('http')) {
    const { protocol, hostname, port } = window.location
    // Vite dev-server (5173/3000) → форсируем go-бэк на 3002.
    if (port === '5173' || port === '3000') {
      return `${protocol}//${hostname}:3002`
    }
    return '' // same-origin
  }
  // 4. SSR / node — fallback на дефолт.
  return 'http://127.0.0.1:3002'
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

// branchMiddleware — multi-branch (ADR-003 Ф4): владелец может смотреть GET-отчёты
// «как филиал X». Выбранный филиал хранится в localStorage; бэк валидирует
// (owner + своя сеть) и подменяет tenant. На write не ставим (только GET).
const branchMiddleware: Middleware = {
  async onRequest({ request }) {
    if (request.method.toUpperCase() !== 'GET') return request
    if (typeof localStorage !== 'undefined') {
      const b = localStorage.getItem('restos-branch-view')
      if (b) request.headers.set('X-Branch-Id', b)
    }
    return request
  },
}

const authExpiredMiddleware: Middleware = {
  async onResponse({ request, response }) {
    // Фоновые/некритичные дозагрузки (профиль, ресторан сразу после логина)
    // помечаются заголовком и НЕ должны выкидывать только что вошедшего юзера
    // глобальным logout'ом при транзиентном 401 — иначе свежий вход
    // откатывается на экран PIN. Critical-запросы (как раньше) логаутят.
    if (response.status === 401 && typeof window !== 'undefined'
        && request?.headers?.get('X-Skip-Auth-Expire') !== '1') {
      const reqToken = request?.headers?.get('Authorization')?.replace('Bearer ', '')
      const currentToken = localStorage.getItem('restos-v4-token')
      if (!reqToken || reqToken !== currentToken) {
        return response
      }
      try {
        window.dispatchEvent(new CustomEvent('restos:auth:expired'))
      } catch {}
    }
    return response
  },
}

// Idempotency-Key. randomId() безопасен в любом контексте: crypto.randomUUID
// есть только в secure context (HTTPS/localhost); по LAN на http://<ip>:3001
// его нет, поэтому падаем на crypto.getRandomValues (полная энтропия v4).
function cryptoRandomUUID(): string {
  return randomId()
}

export const api = createClient<paths>({ baseUrl: getBaseURL() })
api.use(authMiddleware)
api.use(idemMiddleware)
api.use(branchMiddleware)
api.use(authExpiredMiddleware)

// Re-export типов, которые чаще всего нужны компонентам.
export type { paths, components } from './generated'
