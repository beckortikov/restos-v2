'use client'

import { useNavigate } from 'react-router-dom'
import { LayoutGrid, Sparkles, Printer, BookOpen, Users, Upload, LogOut, Copy, ChevronRight, Store, QrCode, Smartphone } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/lib/auth-store'
import { usePosV2Flag } from '@/lib/pos-v2/flag'
import type { PermissionKey } from '@/lib/types'

export default function PosV2Settings() {
  const navigate = useNavigate()
  const { restaurant, user, canDo, logout } = useAuth()
  const [posV2On, setPosV2On] = usePosV2Flag()

  const linksAll: Array<{ icon: React.ElementType; label: string; sub: string; to: string; gate?: PermissionKey }> = [
    { icon: Printer, label: 'Принтеры', sub: 'Чеки и кухонные станции', to: '/settings/printers', gate: 'printers.manage' },
    { icon: BookOpen, label: 'Меню', sub: 'Блюда, цены, стоп-лист', to: '/warehouse/menu', gate: 'menu.view' },
    { icon: Users, label: 'Клиенты', sub: 'База гостей и скидки', to: '/settings/customers', gate: 'customers.manage' },
    { icon: QrCode, label: 'Подключить официантов', sub: 'QR для APK по локальной сети', to: '/show-qr' },
    { icon: Smartphone, label: 'Приложение официанта', sub: 'Загрузка и раздача APK', to: '/settings/waiter-app' },
    { icon: Upload, label: 'Импорт данных', sub: 'Меню, остатки, клиенты', to: '/settings/import', gate: 'data.import' },
  ]
  const links = linksAll.filter(l => !l.gate || canDo(l.gate))

  async function copyId() {
    if (!restaurant?.id) return
    try { await navigator.clipboard.writeText(restaurant.id); toast.success('ID ресторана скопирован') } catch { toast.error('Не удалось') }
  }

  return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      {/* Topbar */}
      <div className="flex items-center shrink-0" style={{ gap: 'var(--pv-gap)', padding: 'var(--pv-gap) var(--pv-pad-x) 0' }}>
        <button onClick={() => navigate('/pos2')} className="flex items-center gap-2 rounded-xl border shrink-0 active:scale-95 transition-transform" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: 'clamp(0.6rem,0.9vw,0.85rem) clamp(0.8rem,1.1vw,1.1rem)' }}>
          <LayoutGrid style={{ width: 'clamp(1.1rem,1.4vw,1.4rem)', height: 'clamp(1.1rem,1.4vw,1.4rem)', color: 'var(--pv-brand)' }} />
          <span className="font-semibold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>Меню</span>
        </button>
        <span className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.15rem,1.8vw,1.6rem)' }}>Настройки</span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto" style={{ padding: 'var(--pv-gap) var(--pv-pad-x) var(--pv-pad-x)' }}>
        <div className="mx-auto flex flex-col" style={{ maxWidth: '48rem', gap: 'var(--pv-gap)' }}>

          {/* Новый интерфейс toggle */}
          <div className="rounded-2xl flex items-center gap-3" style={{ background: 'var(--pv-card)', border: '1px solid var(--pv-border)', padding: 'clamp(1rem,1.5vw,1.4rem)' }}>
            <div className="rounded-xl flex items-center justify-center shrink-0" style={{ background: 'var(--pv-brand-soft)', width: 'clamp(2.6rem,3.4vw,3.2rem)', height: 'clamp(2.6rem,3.4vw,3.2rem)' }}>
              <Sparkles style={{ width: '55%', height: '55%', color: 'var(--pv-brand)' }} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1rem,1.4vw,1.2rem)' }}>Новый интерфейс (бета)</div>
              <div style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>{posV2On ? 'Включён на этой кассе' : 'Классический POS по умолчанию'}</div>
            </div>
            <button onClick={() => { setPosV2On(!posV2On); toast.success(!posV2On ? 'Новый интерфейс включён' : 'Выключен') }} className="rounded-full shrink-0 transition-colors" style={{ width: '3.4rem', height: '2rem', background: posV2On ? 'var(--pv-brand)' : '#d8d3ca', padding: '3px', display: 'flex', justifyContent: posV2On ? 'flex-end' : 'flex-start', alignItems: 'center' }}>
              <span className="rounded-full" style={{ width: '1.5rem', height: '1.5rem', background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.25)' }} />
            </button>
          </div>

          {/* Ресторан */}
          <div className="rounded-2xl flex items-center gap-3" style={{ background: 'var(--pv-card)', border: '1px solid var(--pv-border)', padding: 'clamp(1rem,1.5vw,1.4rem)' }}>
            <div className="rounded-xl flex items-center justify-center shrink-0" style={{ background: 'var(--pv-bg)', width: 'clamp(2.6rem,3.4vw,3.2rem)', height: 'clamp(2.6rem,3.4vw,3.2rem)' }}>
              <Store style={{ width: '55%', height: '55%', color: 'var(--pv-text-2)' }} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-bold truncate" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1rem,1.4vw,1.2rem)' }}>{restaurant?.name || 'Ресторан'}</div>
              <button onClick={copyId} className="flex items-center gap-1.5" style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.1rem)' }}>
                <span className="truncate" style={{ maxWidth: '16rem', fontFamily: 'monospace' }}>{restaurant?.id || '—'}</span>
                <Copy style={{ width: '0.85rem', height: '0.85rem' }} />
              </button>
            </div>
            <span className="rounded-full font-semibold shrink-0" style={{ background: 'var(--pv-brand-soft)', color: 'var(--pv-brand)', padding: '0.3rem 0.8rem', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>{user?.name || 'Кассир'}</span>
          </div>

          {/* Разделы */}
          {links.length > 0 && (
            <>
              <div className="font-semibold" style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.05rem)', marginTop: '0.5rem', marginLeft: '0.25rem' }}>Управление</div>
              <div style={{ display: 'grid', gap: 'var(--pv-gap)', gridTemplateColumns: 'repeat(auto-fill, minmax(clamp(14rem,22vw,20rem), 1fr))' }}>
                {links.map(l => {
                  const Icon = l.icon
                  return (
                    <button key={l.to} onClick={() => navigate(l.to)} className="rounded-2xl flex items-center gap-3 text-left active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-card)', border: '1px solid var(--pv-border)', padding: 'clamp(0.9rem,1.4vw,1.3rem)' }}>
                      <div className="rounded-xl flex items-center justify-center shrink-0" style={{ background: 'var(--pv-bg)', width: 'clamp(2.4rem,3vw,2.9rem)', height: 'clamp(2.4rem,3vw,2.9rem)' }}>
                        <Icon style={{ width: '52%', height: '52%', color: 'var(--pv-brand)' }} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="font-bold truncate" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>{l.label}</div>
                        <div className="truncate" style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.1rem)' }}>{l.sub}</div>
                      </div>
                      <ChevronRight style={{ width: '1.1rem', height: '1.1rem', color: 'var(--pv-text-3)' }} className="shrink-0" />
                    </button>
                  )
                })}
              </div>
              <div style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.15rem)', marginLeft: '0.25rem' }}>Разделы управления открываются в классическом интерфейсе. Вернуться — кнопкой «Новый POS».</div>
            </>
          )}

          {/* Выйти */}
          <button onClick={() => logout()} className="rounded-2xl flex items-center justify-center gap-2 font-semibold active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-occ-soft)', color: 'var(--pv-occ-text)', padding: 'clamp(0.9rem,1.3vw,1.15rem)', fontSize: 'var(--pv-ctl)', marginTop: '0.5rem' }}>
            <LogOut style={{ width: '1.3em', height: '1.3em' }} />Выйти
          </button>
        </div>
      </div>
    </div>
  )
}
