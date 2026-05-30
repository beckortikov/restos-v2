// Vitest setup — выполняется ДО любых тестов. Обеспечивает рабочий
// localStorage в jsdom-окружении.
//
// `lib/api/v4-typed.ts` при module-load вызывает getBaseURL(), который читает
// localStorage. В голом jsdom 29 localStorage иногда возвращает Storage без
// `.getItem` метода (баг или version-specific quirk) — гарантируем
// in-memory polyfill, чтобы импорт api не падал в любом тестовом файле.

class MemoryStorage implements Storage {
  private store = new Map<string, string>()
  get length() { return this.store.size }
  key(i: number) { return Array.from(this.store.keys())[i] ?? null }
  getItem(k: string) { return this.store.has(k) ? this.store.get(k)! : null }
  setItem(k: string, v: string) { this.store.set(k, String(v)) }
  removeItem(k: string) { this.store.delete(k) }
  clear() { this.store.clear() }
}

if (typeof globalThis.localStorage === 'undefined'
  || typeof (globalThis.localStorage as Storage).getItem !== 'function') {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemoryStorage(),
    writable: true,
    configurable: true,
  })
}
if (typeof window !== 'undefined'
  && (typeof window.localStorage === 'undefined'
    || typeof window.localStorage.getItem !== 'function')) {
  Object.defineProperty(window, 'localStorage', {
    value: globalThis.localStorage,
    writable: true,
    configurable: true,
  })
}
