import { describe, it, expect, afterEach } from 'vitest'
import { unstickBodyPointerEvents } from './pointer-events-guard'

afterEach(() => {
  document.body.style.pointerEvents = ''
  document.querySelectorAll('[data-radix-focus-guard]').forEach((n) => n.remove())
})

function addFocusGuard() {
  const g = document.createElement('span')
  g.setAttribute('data-radix-focus-guard', '')
  document.body.appendChild(g)
  return g
}

describe('unstickBodyPointerEvents', () => {
  it('снимает осиротевший body{pointer-events:none} (нет открытых Radix-слоёв)', () => {
    document.body.style.pointerEvents = 'none'
    unstickBodyPointerEvents()
    expect(document.body.style.pointerEvents).toBe('')
  })

  it('НЕ трогает блокировку, пока модалка реально открыта (есть focus-guard)', () => {
    document.body.style.pointerEvents = 'none'
    addFocusGuard()
    unstickBodyPointerEvents()
    expect(document.body.style.pointerEvents).toBe('none') // не сбросили — модалка открыта
  })

  it('снимает залипание после закрытия (guard убран → блокировка осиротела)', () => {
    document.body.style.pointerEvents = 'none'
    const g = addFocusGuard()
    unstickBodyPointerEvents()
    expect(document.body.style.pointerEvents).toBe('none') // ещё открыта
    g.remove() // модалка закрылась/размонтировалась
    unstickBodyPointerEvents()
    expect(document.body.style.pointerEvents).toBe('') // залипание снято
  })

  it('no-op, когда body не заблокирован', () => {
    document.body.style.pointerEvents = 'auto'
    unstickBodyPointerEvents()
    expect(document.body.style.pointerEvents).toBe('auto')
  })
})
