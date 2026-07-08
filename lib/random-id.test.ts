import { describe, it, expect, afterEach, vi } from 'vitest'
import { randomId } from './random-id'

// UUIDv4: версия '4' в 15-й позиции, вариант [89ab] в 20-й.
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('randomId', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('в обычном окружении возвращает UUID (36 символов)', () => {
    expect(randomId()).toMatch(/^[0-9a-f-]{36}$/i)
  })

  it('без crypto.randomUUID (LAN http, не secure context) падает на getRandomValues и даёт валидный UUIDv4', () => {
    // Эмулируем небезопасный контекст: только getRandomValues, без randomUUID —
    // ровно то, что видит владелец/официант при доступе по http://<ip>:3001.
    vi.stubGlobal('crypto', {
      getRandomValues: (arr: Uint8Array) => {
        for (let i = 0; i < arr.length; i++) arr[i] = (i * 37 + 11) & 0xff
        return arr
      },
    })
    expect(randomId()).toMatch(UUID_V4)
  })

  it('без crypto вообще — Math.random-фолбэк остаётся валидным UUIDv4-форматом', () => {
    vi.stubGlobal('crypto', undefined)
    expect(randomId()).toMatch(UUID_V4)
  })

  it('не бросает исключение ни в одном из режимов', () => {
    expect(() => randomId()).not.toThrow()
    vi.stubGlobal('crypto', undefined)
    expect(() => randomId()).not.toThrow()
  })

  it('уникален на многих вызовах (нет фиксированного префикса — иначе коллизии Idempotency-Key)', () => {
    const set = new Set(Array.from({ length: 500 }, () => randomId()))
    expect(set.size).toBe(500)
  })
})
