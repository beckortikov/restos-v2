'use client'

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Utensils, LayoutGrid, Wallet, ChefHat,
  Settings, LogOut, OctagonX, PackageCheck, CookingPot, Lock,
} from 'lucide-react'
import { useAuth } from '@/lib/auth-store'
import { fetchActiveShift } from '@/lib/queries'
import { FailedPrintsButton } from '@/components/order/failed-prints-button'

// Вшивается Vite (define в vite.config.ts) из desktop/package.json.
declare const __APP_VERSION__: string

// Плитки ведут ТОЛЬКО на экраны /pos2/*. Плитка «Кухня (KDS)» убрана — она вела
// на старый POS (/operations/kitchen), из-за чего кассир проваливался в старый
// дизайн. KDS живёт в старом POS / отдельном планшете.
//
// `req` — старый маршрут для проверки прав: плитка видна только если у роли есть
// доступ (hasAccess). Кассир видит лишь доступные ему разделы (как старый rail).
const TILES: Array<{
  icon: React.ElementType
  label: string
  sub: string
  to: string
  req: string
  primary?: boolean
}> = [
  { icon: Utensils, label: 'Новый заказ', sub: 'Меню и оплата', to: '/pos2/order', req: '/operations/pos', primary: true },
  { icon: LayoutGrid, label: 'Карта зала', sub: 'Столы и брони', to: '/pos2/tables', req: '/operations/table-map' },
  { icon: Wallet, label: 'Кассовая смена', sub: 'Выручка · движение · обслуживание', to: '/pos2/shift', req: '/operations/shifts' },
  { icon: OctagonX, label: 'Стоп-лист', sub: 'Стоп/возврат блюд', to: '/pos2/stop', req: '/warehouse/menu' },
  { icon: PackageCheck, label: 'Витрина', sub: 'Списания и полуфабрикаты', to: '/pos2/showcase', req: '/operations/showcase' },
  { icon: CookingPot, label: 'Заготовки', sub: 'Приготовление партий', to: '/pos2/batch', req: '/operations/batch-cooking' },
  { icon: Settings, label: 'Настройки', sub: 'Интерфейс, принтеры, меню', to: '/pos2/settings', req: '/cashier/settings' },
]

export default function PosV2Launcher() {
  const navigate = useNavigate()
  const { user, restaurant, hasAccess } = useAuth()
  // Владелец/менеджер видят всё; кассир/официант — только разделы по своим
  // правам (hasAccess мапит /pos2-плитку на старый маршрут). owner/manager → всё.
  const tiles = TILES.filter(t => hasAccess(t.req))
  const initial = (user?.name || 'К').trim().charAt(0).toUpperCase()
  // Версия ПОС: в Electron — из preload (актуальная у бинаря), иначе — вшитая при
  // сборке (__APP_VERSION__ из desktop/package.json), чтобы показывалась и в LAN-браузере.
  const posVersion = (typeof window !== 'undefined'
    ? (window as unknown as { restosDesktop?: { version?: string } }).restosDesktop?.version
    : undefined) ?? __APP_VERSION__
  // Ручная блокировка экрана доступна только при включённом PIN-локе.
  const pinLockEnabled = restaurant?.pinLockEnabled ?? false
  // Реальный статус смены вместо захардкоженного «Смена открыта» (вводил в
  // заблуждение — показывался всегда). null = ещё грузим, не показываем бейдж.
  const [shiftOpen, setShiftOpen] = useState<boolean | null>(null)
  useEffect(() => {
    let alive = true
    fetchActiveShift().then(s => { if (alive) setShiftOpen(!!s) }).catch(() => { if (alive) setShiftOpen(false) })
    return () => { alive = false }
  }, [])

  return (
    // Fluid: вся высота экрана, без прокрутки. Header/footer сжаты, сетка тянется.
    <div className="flex flex-col h-full w-full overflow-hidden">
      {/* Header */}
      <header
        className="flex items-center justify-between shrink-0 border-b"
        style={{
          borderColor: 'var(--pv-border)',
          padding: 'clamp(0.7rem,1.5vw,1.4rem) var(--pv-pad-x)',
          gap: 'var(--pv-gap)',
        }}
      >
        <div className="flex items-center min-w-0" style={{ gap: 'clamp(0.55rem,1vw,0.9rem)' }}>
          <div
            className="rounded-2xl flex items-center justify-center shrink-0"
            style={{ background: 'var(--pv-brand)', width: 'var(--pv-logo)', height: 'var(--pv-logo)' }}
          >
            <ChefHat className="text-white" style={{ width: '54%', height: '54%' }} />
          </div>
          <div className="min-w-0">
            <div
              className="font-bold leading-tight truncate"
              style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-h-title)' }}
            >
              {restaurant?.name || 'RestOS'}
            </div>
            <div
              className="truncate hidden sm:block"
              style={{ color: 'var(--pv-text-3)', fontSize: 'clamp(0.7rem,0.95vw,0.9rem)' }}
            >
              {`Терминал кассира · v${posVersion}`}
            </div>
          </div>
        </div>

        <div className="flex items-center shrink-0" style={{ gap: 'clamp(0.4rem,0.8vw,0.75rem)' }}>
          {/* Непечатанные кухонные задания — retry/dismiss (как в старом POS) */}
          <FailedPrintsButton />
          {shiftOpen !== null && (
            <div
              className="hidden md:flex items-center gap-2 rounded-full"
              style={{ background: shiftOpen ? 'var(--pv-free-soft)' : 'var(--pv-bill-soft)', padding: 'clamp(0.4rem,0.6vw,0.6rem) clamp(0.7rem,1vw,1rem)' }}
            >
              <span className="size-2.5 rounded-full shrink-0" style={{ background: shiftOpen ? 'var(--pv-free-dot)' : 'var(--pv-bill-dot)' }} />
              <span className="font-semibold whitespace-nowrap" style={{ color: shiftOpen ? 'var(--pv-free-text)' : 'var(--pv-bill-text)', fontSize: 'var(--pv-ctl)' }}>
                {shiftOpen ? 'Смена открыта' : 'Смена закрыта'}
              </span>
            </div>
          )}
          <div
            className="flex items-center gap-2 rounded-full border"
            style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: 'clamp(0.3rem,0.5vw,0.5rem) clamp(0.7rem,1vw,1rem) clamp(0.3rem,0.5vw,0.5rem) clamp(0.3rem,0.4vw,0.5rem)' }}
          >
            <div
              className="rounded-full flex items-center justify-center font-bold shrink-0"
              style={{ background: 'var(--pv-brand-soft)', color: 'var(--pv-brand)', width: 'clamp(1.75rem,2.4vw,2.25rem)', height: 'clamp(1.75rem,2.4vw,2.25rem)', fontSize: 'var(--pv-ctl)' }}
            >
              {initial}
            </div>
            <span className="font-semibold hidden sm:block whitespace-nowrap" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>
              {user?.name || 'Кассир'}
            </span>
          </div>
          {/* Блокировка экрана PIN'ом — вручную из меню (виден при включённом
              PIN-локе). Шлёт событие, LockGate в PosV2Layout ставит блок. */}
          {pinLockEnabled && (
            <button
              onClick={() => window.dispatchEvent(new Event('pos-v2:lock-request'))}
              className="flex items-center justify-center rounded-xl border transition-transform active:scale-95 shrink-0"
              style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', color: 'var(--pv-text-2)', width: 'clamp(2.4rem,3.2vw,3rem)', height: 'clamp(2.4rem,3.2vw,3rem)' }}
              title="Заблокировать экран (PIN)"
              aria-label="Заблокировать экран"
            >
              <Lock style={{ width: 'clamp(1.05rem,1.4vw,1.25rem)', height: 'clamp(1.05rem,1.4vw,1.25rem)' }} />
            </button>
          )}
          <button
            onClick={() => navigate('/operations/pos')}
            className="flex items-center gap-2 rounded-xl transition-transform active:scale-95 shrink-0"
            style={{ background: 'var(--pv-occ-soft)', color: 'var(--pv-occ-text)', padding: 'clamp(0.55rem,0.8vw,0.8rem) clamp(0.75rem,1.1vw,1.1rem)' }}
          >
            <LogOut style={{ width: 'clamp(1.05rem,1.4vw,1.25rem)', height: 'clamp(1.05rem,1.4vw,1.25rem)' }} />
            <span className="font-semibold whitespace-nowrap" style={{ fontSize: 'var(--pv-ctl)' }}>Выход</span>
          </button>
        </div>
      </header>

      {/* Grid — тянется на всю доступную высоту, плитки делят её поровну (auto-rows-fr) */}
      <main
        className="flex-1 min-h-0 flex flex-col"
        style={{ padding: 'var(--pv-gap) var(--pv-pad-x) var(--pv-pad-x)' }}
      >
        <div
          className="shrink-0 font-semibold"
          style={{ color: 'var(--pv-text-3)', fontSize: 'clamp(0.72rem,0.95vw,0.9rem)', marginBottom: 'var(--pv-gap)' }}
        >
          Быстрый доступ
        </div>
        <div
          className="grid flex-1 min-h-0 grid-cols-2 md:grid-cols-4 auto-rows-fr"
          style={{ gap: 'var(--pv-gap)' }}
        >
          {tiles.map((t) => {
            const Icon = t.icon
            return (
              <button
                key={t.label}
                onClick={() => navigate(t.to)}
                className="flex flex-col justify-center rounded-2xl text-left transition-transform active:scale-[0.98] min-h-0 overflow-hidden"
                style={{
                  padding: 'var(--pv-tile-pad)',
                  gap: 'clamp(0.5rem,1.1vw,1rem)',
                  ...(t.primary
                    ? { background: 'var(--pv-brand)', boxShadow: '0 8px 24px rgba(216,90,48,0.33)' }
                    : { background: 'var(--pv-card)', border: '1px solid var(--pv-border)', boxShadow: '0 2px 10px rgba(0,0,0,0.04)' }),
                }}
              >
                <div
                  className="rounded-2xl flex items-center justify-center shrink-0"
                  style={{
                    width: 'var(--pv-tile-icon)',
                    height: 'var(--pv-tile-icon)',
                    background: t.primary ? 'rgba(255,255,255,0.16)' : 'var(--pv-brand-soft)',
                  }}
                >
                  <Icon style={{ width: '50%', height: '50%', color: t.primary ? '#fff' : 'var(--pv-brand)' }} />
                </div>
                <div className="min-w-0">
                  <div
                    className="font-bold leading-tight truncate"
                    style={{ fontSize: 'var(--pv-tile-title)', color: t.primary ? '#fff' : 'var(--pv-text)' }}
                  >
                    {t.label}
                  </div>
                  <div
                    className="font-medium truncate"
                    style={{ fontSize: 'var(--pv-tile-sub)', color: t.primary ? 'rgba(255,255,255,0.82)' : 'var(--pv-text-3)', marginTop: '0.15rem' }}
                  >
                    {t.sub}
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      </main>

      {/* Footer — прячем на низких экранах, чтобы гарантированно влезло */}
      <footer
        className="hidden lg:block shrink-0"
        style={{ padding: '0.75rem var(--pv-pad-x)', color: 'var(--pv-text-3)', fontSize: '0.72rem' }}
      >
        Бета-интерфейс. «Выход» возвращает в классическую кассу. Экраны открываются в текущем дизайне и по мере готовности заменяются новыми.
      </footer>
    </div>
  )
}
