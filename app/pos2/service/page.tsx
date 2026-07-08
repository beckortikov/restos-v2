'use client'

import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { LayoutGrid, RefreshCw, HandCoins, Check, Percent } from 'lucide-react'
import { toast } from 'sonner'
import {
  fetchActiveShift, fetchServiceAccrualByShift, fetchServicePayoutByShift,
  fetchUsers, fetchFinancialAccounts, payServiceCharge,
} from '@/lib/queries'
import { formatCurrency } from '@/lib/helpers'
import { dSum } from '@/lib/decimal'
import { humanizeError } from '@/lib/errors'
import type { CashShift, FinancialAccount } from '@/lib/types'

interface Row { waiterId: string; waiterName: string; ordersCount: number; accrued: number; paid: number; toPay: number }

// Phase 2.10: обслуживание официантов в /pos2 — начислено/выплачено/к выплате по
// смене + выплата. Те же серверные функции, что старый POS.
export default function PosV2Service() {
  const navigate = useNavigate()
  const [shift, setShift] = useState<CashShift | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [accounts, setAccounts] = useState<FinancialAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [payingId, setPayingId] = useState<string | null>(null)
  const payRef = useRef(false)

  const cashAcc = useMemo(() => accounts.find(a => a.type === 'cash') ?? accounts[0], [accounts])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const active = await fetchActiveShift().catch(() => null)
      setShift(active)
      if (!active) { setRows([]); return }
      const [accrual, payout, users] = await Promise.all([
        fetchServiceAccrualByShift(active.id).catch(() => []),
        fetchServicePayoutByShift(active.id).catch(() => ({} as Record<string, number>)),
        fetchUsers().catch(() => []),
      ])
      const nameById = new Map(users.map(u => [u.id, u.name]))
      setRows(
        accrual
          .filter(r => r.waiterId)
          .map(r => {
            const wid = r.waiterId as string
            const paid = payout[wid] ?? 0
            return { waiterId: wid, waiterName: nameById.get(wid) ?? 'Без имени', ordersCount: r.ordersCount, accrued: r.accrued, paid, toPay: Math.max(0, r.accrued - paid) }
          })
          .sort((a, b) => b.toPay - a.toPay),
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    fetchFinancialAccounts().then(setAccounts).catch(() => {})
  }, [load])

  const totalAccrued = useMemo(() => dSum(rows.map(r => r.accrued)), [rows])
  const totalPaid = useMemo(() => dSum(rows.map(r => r.paid)), [rows])
  const totalToPay = useMemo(() => dSum(rows.map(r => r.toPay)), [rows])

  async function pay(r: Row) {
    if (payRef.current || r.toPay <= 0 || !shift) return
    if (!cashAcc) { toast.error('Нет кассового счёта для выплаты'); return }
    payRef.current = true; setPayingId(r.waiterId)
    try {
      await payServiceCharge({
        waiterId: r.waiterId, waiterName: r.waiterName, amount: r.toPay,
        accountId: cashAcc.id, accountName: cashAcc.name,
        periodFrom: shift.openedAt, periodTo: new Date().toISOString(), shiftId: shift.id,
      })
      toast.success(`Выплачено · ${r.waiterName} · ${formatCurrency(r.toPay)}`)
      await load()
    } catch (e) {
      toast.error(`Не удалось выплатить: ${humanizeError(e)}`)
    } finally {
      payRef.current = false; setPayingId(null)
    }
  }

  function initials(name: string) { return name.trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('') }

  return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      {/* Topbar */}
      <div className="flex items-center shrink-0" style={{ gap: 'var(--pv-gap)', padding: 'var(--pv-gap) var(--pv-pad-x) 0' }}>
        <button onClick={() => navigate('/pos2')} className="flex items-center gap-2 rounded-xl border shrink-0 active:scale-95 transition-transform" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: 'clamp(0.6rem,0.9vw,0.85rem) clamp(0.8rem,1.1vw,1.1rem)' }}>
          <LayoutGrid style={{ width: 'clamp(1.1rem,1.4vw,1.4rem)', height: 'clamp(1.1rem,1.4vw,1.4rem)', color: 'var(--pv-brand)' }} />
          <span className="font-semibold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>Меню</span>
        </button>
        <span className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.15rem,1.8vw,1.6rem)' }}>Обслуживание официантов</span>
        <div className="flex-1" />
        <button onClick={() => load()} className="flex items-center gap-2 rounded-xl border shrink-0 active:scale-95 transition-transform" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: 'clamp(0.6rem,0.9vw,0.85rem) clamp(0.8rem,1.1vw,1.1rem)' }}>
          <RefreshCw style={{ width: 'clamp(1.05rem,1.3vw,1.3rem)', height: 'clamp(1.05rem,1.3vw,1.3rem)', color: 'var(--pv-text-2)' }} className={loading ? 'animate-spin' : ''} />
          <span className="font-semibold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>Обновить</span>
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto" style={{ padding: 'var(--pv-gap) var(--pv-pad-x) var(--pv-pad-x)' }}>
        {loading ? (
          <div className="h-full flex items-center justify-center" style={{ color: 'var(--pv-text-3)' }}>Загрузка…</div>
        ) : !shift ? (
          <div className="h-full flex flex-col items-center justify-center gap-2" style={{ color: 'var(--pv-text-3)' }}>
            <HandCoins style={{ width: '2.5rem', height: '2.5rem', opacity: 0.5 }} />
            <span style={{ fontSize: 'var(--pv-ctl)' }}>Смена не открыта</span>
          </div>
        ) : (
          <div className="flex flex-col" style={{ gap: 'var(--pv-gap)' }}>
            {/* KPIs */}
            <div style={{ display: 'grid', gap: 'var(--pv-gap)', gridTemplateColumns: 'repeat(3, 1fr)' }}>
              {([['Всего начислено', totalAccrued, 'var(--pv-bill-text)', 'var(--pv-bill-soft)'], ['Выплачено', totalPaid, 'var(--pv-free-text)', 'var(--pv-free-soft)'], ['К выплате', totalToPay, 'var(--pv-brand)', 'var(--pv-brand-soft)']] as const).map(([label, val, color, bg]) => (
                <div key={label} className="rounded-2xl flex items-center gap-3" style={{ background: 'var(--pv-card)', border: '1px solid var(--pv-border)', padding: 'clamp(0.9rem,1.4vw,1.4rem)' }}>
                  <div className="rounded-xl flex items-center justify-center shrink-0" style={{ background: bg, width: 'clamp(2.4rem,3.2vw,3rem)', height: 'clamp(2.4rem,3.2vw,3rem)' }}>
                    {label === 'Выплачено' ? <Check style={{ width: '55%', height: '55%', color }} /> : label === 'К выплате' ? <HandCoins style={{ width: '55%', height: '55%', color }} /> : <Percent style={{ width: '55%', height: '55%', color }} />}
                  </div>
                  <div className="min-w-0">
                    <div className="font-bold truncate" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.15rem,1.7vw,1.6rem)' }}>{formatCurrency(val)}</div>
                    <div style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>{label}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* Waiter rows */}
            {rows.length === 0 ? (
              <div className="text-center" style={{ color: 'var(--pv-text-3)', padding: '2rem', fontSize: 'var(--pv-ctl)' }}>Нет начислений по обслуживанию в этой смене</div>
            ) : rows.map(r => (
              <div key={r.waiterId} className="flex items-center gap-3 rounded-2xl" style={{ background: 'var(--pv-card)', border: '1px solid var(--pv-border)', padding: 'clamp(0.8rem,1.3vw,1.2rem)' }}>
                <div className="rounded-full flex items-center justify-center font-bold shrink-0" style={{ background: 'var(--pv-brand-soft)', color: 'var(--pv-brand)', width: 'clamp(2.5rem,3.4vw,3.25rem)', height: 'clamp(2.5rem,3.4vw,3.25rem)', fontSize: 'var(--pv-ctl)' }}>{initials(r.waiterName)}</div>
                <div className="min-w-0 flex-1">
                  <div className="font-bold truncate" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1rem,1.4vw,1.25rem)' }}>{r.waiterName}</div>
                  <div style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>{r.ordersCount} зак. · начислено {formatCurrency(r.accrued)} · выплачено {formatCurrency(r.paid)}</div>
                </div>
                <div className="text-right shrink-0" style={{ marginRight: '0.5rem' }}>
                  <div className="font-bold" style={{ color: r.toPay > 0 ? 'var(--pv-brand)' : 'var(--pv-text-3)', fontSize: 'clamp(1.1rem,1.6vw,1.5rem)' }}>{formatCurrency(r.toPay)}</div>
                  <div style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.1rem)' }}>к выплате</div>
                </div>
                {r.toPay > 0 ? (
                  <button disabled={payingId === r.waiterId} onClick={() => pay(r)} className="flex items-center gap-2 rounded-xl font-bold text-white shrink-0 disabled:opacity-50 active:scale-95 transition-transform" style={{ background: 'var(--pv-brand)', padding: 'clamp(0.6rem,0.9vw,0.85rem) clamp(0.9rem,1.3vw,1.3rem)' }}>
                    <HandCoins style={{ width: 'clamp(1rem,1.3vw,1.25rem)', height: 'clamp(1rem,1.3vw,1.25rem)' }} />
                    <span style={{ fontSize: 'var(--pv-ctl)' }}>{payingId === r.waiterId ? 'Выплата…' : 'Выплатить'}</span>
                  </button>
                ) : (
                  <div className="flex items-center gap-1.5 rounded-xl shrink-0" style={{ background: 'var(--pv-free-soft)', color: 'var(--pv-free-text)', padding: 'clamp(0.55rem,0.8vw,0.75rem) clamp(0.8rem,1.1vw,1.1rem)' }}>
                    <Check style={{ width: '1.1rem', height: '1.1rem' }} />
                    <span className="font-semibold" style={{ fontSize: 'var(--pv-ctl)' }}>Выплачено</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
