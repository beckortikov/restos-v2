// lib/api/index.ts — публичный фасад API-слоя.
//
// Новый код:
//   import { api, unwrap } from '@/lib/api'
//   const data = await unwrap(api.GET('/api/v1/orders', { params: { query: { limit: 50 } } }))
//
// `api` — openapi-fetch клиент с middleware (auth/idempotency/401).
// `unwrap` — выбрасывает V4Error если response.error, иначе возвращает data.
//
// Token хранится в localStorage['restos-v4-token']. Auth-middleware читает
// его на каждом запросе — никаких stale-token bugs.

import { api as typedApi } from './v4-typed'

export { api } from './v4-typed'
export { getBaseURL } from './v4-typed'
export type { paths, components } from './v4-typed'

/**
 * V4Error — структурированная ошибка от Go-бэка.
 * Содержит HTTP status и распарсенный ErrorEnvelope (если есть).
 */
export class V4Error extends Error {
  constructor(public status: number, private body: unknown) {
    super(extractMessage(body) || `v4 ${status}`)
    this.name = 'V4Error'
  }
  /** Возвращает структурированный ErrorEnvelope (если сервер его вернул). */
  envelope(): { code?: string; message?: string } | null {
    if (this.body && typeof this.body === 'object') return this.body as any
    return null
  }
}

function extractMessage(body: unknown): string | null {
  if (!body) return null
  if (typeof body === 'object' && body !== null) {
    const m = (body as any).message
    if (typeof m === 'string') return m
  }
  if (typeof body === 'string') return body
  return null
}

/**
 * unwrap — превращает результат api.X(...) в data | throw V4Error.
 * Используй для эндпоинтов где 404/4xx — это ошибка.
 * Для случаев «404 = вернуть null» используй unwrapOr404 либо проверяй
 * res.response.status вручную (см. unwrapRaw).
 */
export async function unwrap<T>(
  p: Promise<{ data?: T; error?: unknown; response: Response }> | Promise<any>,
): Promise<T> {
  const r: any = await p
  if (r.error !== undefined) throw new V4Error(r.response.status, r.error)
  if (r.data === undefined) {
    // openapi-fetch возвращает data=undefined для 204 No Content.
    // Многие наши write-эндпоинты так делают. Возвращаем undefined as T.
    return undefined as unknown as T
  }
  return r.data as T
}

/**
 * unwrapOr404 — для эндпоинтов где 404 = «нет такого, верни null».
 */
export async function unwrapOr404<T>(
  p: Promise<{ data?: T; error?: unknown; response: Response }> | Promise<any>,
): Promise<T | null> {
  const r: any = await p
  if (r.response && r.response.status === 404) return null
  if (r.error !== undefined) throw new V4Error(r.response.status, r.error)
  if (r.data === undefined) return null
  return r.data as T
}

/** unwrapRaw — отдаёт сырой ответ для случаев, когда нужен response.status. */
export async function unwrapRaw<T = any>(
  p: Promise<{ data?: T; error?: unknown; response: Response }> | Promise<any>,
): Promise<{ data?: T; error?: unknown; response: Response }> {
  return (await p) as any
}

/** Token-helpers. */
export function setV4Token(token: string) {
  if (typeof localStorage !== 'undefined') localStorage.setItem('restos-v4-token', token)
}
export function getV4Token(): string | null {
  if (typeof localStorage === 'undefined') return null
  return localStorage.getItem('restos-v4-token')
}
export function clearV4Token() {
  if (typeof localStorage !== 'undefined') localStorage.removeItem('restos-v4-token')
}

/** Восстановить restaurant_id (после bootstrap). */
const RID_KEY = 'restos-v4-restaurant-id'
export function setV4RestaurantId(id: string) {
  try { localStorage.setItem(RID_KEY, id) } catch {}
}
export function getV4RestaurantId(): string | null {
  try { return localStorage.getItem(RID_KEY) } catch { return null }
}
export function clearV4RestaurantId() {
  try { localStorage.removeItem(RID_KEY) } catch {}
}

/** Унифицированная обёртка для извлечения сообщения из v4-ошибки. */
export function v4ErrorMessage(e: unknown): string {
  if (e instanceof V4Error) {
    const env = e.envelope()
    if (env?.message) return env.message
    return e.message
  }
  if (e instanceof Error) return e.message
  return String(e)
}

// Suppress unused-import warning — `typedApi` is re-exported above as `api`.
void typedApi
