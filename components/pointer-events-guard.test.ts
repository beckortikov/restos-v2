import { describe, it, expect, afterEach } from 'vitest'
import { unstickBodyPointerEvents } from './pointer-events-guard'

afterEach(() => {
  document.body.style.pointerEvents = ''
  document.querySelectorAll('[data-open-modal-fixture]').forEach((n) => n.remove())
})

// Симуляция РЕАЛЬНО открытой Radix-модалки: контент диалога с data-state="open".
function addOpenModal() {
  const el = document.createElement('div')
  el.setAttribute('role', 'dialog')
  el.setAttribute('data-state', 'open')
  el.setAttribute('data-open-modal-fixture', '')
  document.body.appendChild(el)
  return el
}

describe('unstickBodyPointerEvents', () => {
  it('снимает осиротевший body{pointer-events:none} (нет открытых Radix-слоёв)', () => {
    document.body.style.pointerEvents = 'none'
    unstickBodyPointerEvents()
    expect(document.body.style.pointerEvents).toBe('')
  })

  it('НЕ трогает блокировку, пока модалка реально открыта (data-state="open")', () => {
    document.body.style.pointerEvents = 'none'
    addOpenModal()
    unstickBodyPointerEvents()
    expect(document.body.style.pointerEvents).toBe('none') // не сбросили — модалка открыта
  })

  it('снимает залипание после закрытия модалки (контент убран → блокировка осиротела)', () => {
    document.body.style.pointerEvents = 'none'
    const m = addOpenModal()
    unstickBodyPointerEvents()
    expect(document.body.style.pointerEvents).toBe('none') // ещё открыта
    m.remove() // модалка закрылась/размонтировалась
    unstickBodyPointerEvents()
    expect(document.body.style.pointerEvents).toBe('') // залипание снято
  })

  it('снимает залипание даже если остался ЗАЛИПШИЙ focus-guard (без открытой модалки)', () => {
    // Ключевой кейс: диалог закрылся, но edge focus-guard остался в DOM и body
    // застрял 'none'. Раньше guard видел focus-guard и НЕ снимал — инпуты мёртвые.
    document.body.style.pointerEvents = 'none'
    const fg = document.createElement('span')
    fg.setAttribute('data-radix-focus-guard', '')
    fg.setAttribute('data-open-modal-fixture', '') // чтобы afterEach убрал
    document.body.appendChild(fg)
    unstickBodyPointerEvents()
    expect(document.body.style.pointerEvents).toBe('') // снято, focus-guard больше не блокирует
  })

  it('no-op, когда body не заблокирован', () => {
    document.body.style.pointerEvents = 'auto'
    unstickBodyPointerEvents()
    expect(document.body.style.pointerEvents).toBe('auto')
  })
})
