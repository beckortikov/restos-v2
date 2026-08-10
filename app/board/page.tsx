'use client'

// ТВ-табло выдачи (/board) — как в KFC: «Готовится» (красная полоса заполняется
// по времени готовки) и «Готово» (крупные зелёные номера). Пассивная витрина
// для телевизора: ТВ открывает http://<ip-кассы>:3002/board в браузере, вход
// один раз PIN'ом (BoardLayout).
//
// Источник статусов — per-dish кухонная доска (order_items.station_status),
// которой управляет кухонное приложение (Kotlin) через /kds/items/{id}/status.
// НЕ order.status: в фастфуде заказ оплачен и висит closed/open, а «готовится/
// готово» живёт на уровне позиций. Табло сворачивает позиции в заказы и обновляет
// их по SSE (kds.item.updated → useQuerySseBridge инвалидит ['kds']) + поллинг.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchKdsItems } from '@/lib/queries'
import { Maximize2 } from 'lucide-react'
import { aggregate, cookProgress, splitBoard } from './board-logic'

let audioCtx: AudioContext | null = null
function beep(freq: number, at: number, ctx: AudioContext) {
  const o = ctx.createOscillator()
  const g = ctx.createGain()
  o.connect(g)
  g.connect(ctx.destination)
  o.type = 'sine'
  o.frequency.value = freq
  g.gain.setValueAtTime(0.0001, at)
  g.gain.exponentialRampToValueAtTime(0.35, at + 0.02)
  g.gain.exponentialRampToValueAtTime(0.0001, at + 0.45)
  o.start(at)
  o.stop(at + 0.45)
}
function playChime() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    if (!audioCtx) audioCtx = new Ctx()
    const ctx = audioCtx
    if (ctx.state === 'suspended') ctx.resume().catch(() => {})
    beep(880, ctx.currentTime, ctx)
    beep(1175, ctx.currentTime + 0.18, ctx)
  } catch {
    /* автоплей заблокирован до взаимодействия — не критично */
  }
}

export default function BoardPage() {
  const { data: items = [], dataUpdatedAt } = useQuery({
    queryKey: ['kds', 'board'],
    queryFn: () => fetchKdsItems(['pending', 'cooking', 'ready']),
    refetchInterval: 15_000, // страховка, если SSE пропустит событие
  })

  // Тик для «оживления» полос прогресса (перерисовываем каждые 5 с).
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(id)
  }, [])

  const { cooking, ready } = useMemo(() => splitBoard(aggregate(items)), [items])

  // Звук + вспышка на НОВЫЙ «Готово». На первой загрузке не звеним.
  const prevReady = useRef<Set<number> | null>(null)
  useEffect(() => {
    const cur = new Set(ready.map(o => o.orderNumber))
    if (prevReady.current) {
      for (const n of cur)
        if (!prevReady.current.has(n)) {
          playChime()
          break
        }
    }
    prevReady.current = cur
  }, [ready])
  const newestReady = ready[0]?.orderNumber

  return (
    <div className="fixed inset-0 grid" style={{ gridTemplateColumns: '1.15fr 1fr', background: '#0b0e13' }}>
      {/* ─── Готовится ─── */}
      <section className="min-h-0 flex flex-col" style={{ borderRight: '1px solid rgba(255,255,255,0.07)', padding: 'clamp(16px,2vw,32px)' }}>
        <h2 style={{ textAlign: 'center', color: '#ff5a4d', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.14em', fontSize: 'clamp(20px,2.2vw,34px)', paddingBottom: '0.5em', marginBottom: '0.7em', borderBottom: '2px solid rgba(255,90,77,0.25)' }}>
          Готовится
        </h2>
        <div className="flex-1 min-h-0 overflow-hidden" style={{ display: 'flex', flexDirection: 'column', gap: 'clamp(10px,1.4vw,20px)' }}>
          {cooking.length === 0 ? (
            <p style={{ textAlign: 'center', color: '#3a424e', marginTop: '2em', fontSize: 'clamp(16px,1.6vw,24px)' }}>Нет заказов в работе</p>
          ) : (
            cooking.map(o => {
              const p = cookProgress(o, now, dataUpdatedAt)
              return (
                <div key={o.orderNumber} style={{ background: '#141a22', borderRadius: 16, padding: 'clamp(10px,1.1vw,18px) clamp(14px,1.4vw,22px)' }}>
                  <div style={{ color: '#fff', fontWeight: 800, lineHeight: 0.85, fontVariantNumeric: 'tabular-nums', fontSize: 'clamp(40px,5.2vw,92px)', marginBottom: '0.22em' }}>
                    {o.orderNumber}
                  </div>
                  <div style={{ height: 'clamp(12px,1.1vw,18px)', borderRadius: 9, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                    {/* scaleX (GPU-композит), не width — плавно и без layout-thrash;
                        скруглённый трек с overflow:hidden обрезает прямоугольную заливку. */}
                    <div style={{ height: '100%', width: '100%', transformOrigin: 'left', transform: `scaleX(${p})`, background: 'linear-gradient(90deg,#ff3b30,#ff6b5c)', transition: 'transform 1s linear', willChange: 'transform' }} />
                  </div>
                </div>
              )
            })
          )}
        </div>
      </section>

      {/* ─── Готово ─── */}
      <section className="min-h-0 flex flex-col" style={{ padding: 'clamp(16px,2vw,32px)', background: 'linear-gradient(180deg,rgba(34,197,94,0.10),rgba(34,197,94,0.03))' }}>
        <h2 style={{ textAlign: 'center', color: '#34d17f', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.14em', fontSize: 'clamp(20px,2.2vw,34px)', paddingBottom: '0.5em', marginBottom: '0.7em', borderBottom: '2px solid rgba(52,209,127,0.3)' }}>
          Готово
        </h2>
        <div className="flex-1 min-h-0 overflow-hidden" style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', alignContent: 'flex-start', alignItems: 'center', gap: 'clamp(14px,1.6vw,28px)' }}>
          {ready.length === 0 ? (
            <p style={{ color: '#2e6b46', fontSize: 'clamp(16px,1.6vw,24px)' }}>Готовых заказов нет</p>
          ) : (
            ready.map(o => {
              const isNewest = o.orderNumber === newestReady
              return (
                <span
                  key={o.orderNumber}
                  style={{
                    fontWeight: isNewest ? 900 : 800,
                    fontVariantNumeric: 'tabular-nums',
                    lineHeight: 0.9,
                    fontSize: 'clamp(44px,6.4vw,110px)',
                    color: isNewest ? '#062a13' : '#4ade80',
                    background: isNewest ? '#22c55e' : 'transparent',
                    borderRadius: isNewest ? 18 : 0,
                    padding: isNewest ? '0.06em 0.28em' : 0,
                    boxShadow: isNewest ? '0 0 44px rgba(34,197,94,0.55)' : 'none',
                  }}
                >
                  {o.orderNumber}
                </span>
              )
            })
          )}
        </div>
      </section>

      {/* Полноэкранный режим для ТВ-браузера (скрывает хром браузера). */}
      <button
        onClick={() => {
          document.documentElement.requestFullscreen?.().catch(() => {})
        }}
        title="Полный экран"
        style={{ position: 'fixed', top: 10, right: 10, background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.5)', border: 'none', borderRadius: 8, padding: 8, cursor: 'pointer', opacity: 0.4 }}
      >
        <Maximize2 style={{ width: 18, height: 18 }} />
      </button>
    </div>
  )
}
