import { describe, it, expect } from 'vitest'
import { mapPrintJobEntry, type PrintJournalEntry } from './audit'

// Регресс: кассир жмёт «Не актуально» → сервер ставит status='dismissed', но
// маппер хардкодил dismissed:false и не распознавал этот статус. Drawer
// FailedPrintsButton прячет задания по булеву entry.dismissed И по
// status!=='success'. Отменённое задание (status='dismissed' → uiStatus='mock',
// dismissed=false) проходило ОБА условия и ВОЗВРАЩАЛОСЬ на следующем polls —
// «отменяю, но возвращается». Фикс: dismissed = (status === 'dismissed').

// Точная копия фильтра из components/order/failed-prints-button.tsx.
function passesFailureDrawer(j: PrintJournalEntry): boolean {
  return (
    (j.action === 'print.runner' || j.action === 'print.cancel') &&
    j.status !== 'success' &&
    !j.virtual &&
    !j.dismissed
  )
}

describe('mapPrintJobEntry — dismissed', () => {
  it('status="dismissed" → dismissed=true (иначе задание возвращается в drawer)', () => {
    const e = mapPrintJobEntry({ id: 'j1', type: 'runner', status: 'dismissed', order_number: 7 })
    expect(e.dismissed).toBe(true)
  })

  it('отменённый runner НЕ проходит фильтр failure-drawer', () => {
    const e = mapPrintJobEntry({ id: 'j1', type: 'runner', status: 'dismissed', order_number: 7 })
    expect(passesFailureDrawer(e)).toBe(false)
  })

  it('failed runner (не отменённый) ОСТАётся в drawer', () => {
    const e = mapPrintJobEntry({ id: 'j2', type: 'runner', status: 'failed', last_error: 'tcp timeout' })
    expect(e.dismissed).toBe(false)
    expect(passesFailureDrawer(e)).toBe(true)
  })

  it('pending/running (mock) остаётся в drawer, dismissed=false', () => {
    const e = mapPrintJobEntry({ id: 'j3', type: 'runner', status: 'pending' })
    expect(e.dismissed).toBe(false)
    expect(passesFailureDrawer(e)).toBe(true)
  })

  it('успешная печать (done) не dismissed и не в drawer', () => {
    const e = mapPrintJobEntry({ id: 'j4', type: 'runner', status: 'done' })
    expect(e.status).toBe('success')
    expect(passesFailureDrawer(e)).toBe(false)
  })
})
