// crypto.randomUUID() есть только в secure context (HTTPS/localhost).
// На LAN-сервере по http://192.168.x.y/* Safari/iOS не отдаёт randomUUID.
// crypto.getRandomValues работает в любом контексте — собираем UUIDv4 руками.
export function randomId(): string {
  const c = (typeof globalThis !== 'undefined' ? (globalThis as { crypto?: Crypto }).crypto : undefined)
  if (c?.randomUUID) return c.randomUUID()
  if (c?.getRandomValues) {
    const b = new Uint8Array(16)
    c.getRandomValues(b)
    b[6] = (b[6] & 0x0f) | 0x40
    b[8] = (b[8] & 0x3f) | 0x80
    const h = Array.from(b, x => x.toString(16).padStart(2, '0'))
    return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10, 16).join('')}`
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, ch => {
    const r = (Math.random() * 16) | 0
    const v = ch === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}
