'use client'

import { FinanceTabs } from '@/components/finance/finance-tabs'

import { useState, useEffect, useMemo } from 'react'
import { useAuth } from '@/lib/auth-store'
import { formatCurrency } from '@/lib/helpers'
import { type RecurringPayment } from '@/lib/types'
import { fetchRecurringPayments, updateRecurringPayment, deleteRecurringPayment } from '@/lib/queries'
import {
  Plus, CalendarClock, CreditCard, Pencil, Trash2, Pause, Play, AlertTriangle,
} from 'lucide-react'
import { RecurringPaymentDialog } from '@/components/dialogs/recurring-payment-dialog'
import { PayRecurringDialog } from '@/components/dialogs/pay-recurring-dialog'
import { toast } from 'sonner'

// daysUntil — сколько дней до YYYY-MM-DD (отрицательно = просрочено). Считаем в
// UTC по календарным дням, чтобы не плыло от времени суток.
function daysUntil(due?: string): number | null {
  if (!due) return null
  const [y, m, d] = due.split('-').map(Number)
  if (!y || !m || !d) return null
  const dueMs = Date.UTC(y, m - 1, d)
  const now = new Date()
  const todayMs = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((dueMs - todayMs) / 86400000)
}

// Статус срока: просрочено / сегодня-скоро (≤7 дней) / позже / пауза.
function dueStatus(p: RecurringPayment): { label: string; color: string; urgent: boolean } {
  if (!p.active) return { label: 'Приостановлен', color: 'bg-muted text-muted-foreground', urgent: false }
  const d = daysUntil(p.nextDue)
  if (d === null) return { label: '—', color: 'bg-muted text-muted-foreground', urgent: false }
  if (d < 0) return { label: `Просрочено на ${-d} дн.`, color: 'bg-red-100 text-red-700', urgent: true }
  if (d === 0) return { label: 'Сегодня', color: 'bg-amber-100 text-amber-700', urgent: true }
  if (d <= 7) return { label: `Через ${d} дн.`, color: 'bg-amber-100 text-amber-700', urgent: true }
  return { label: p.nextDue ?? '', color: 'bg-muted text-muted-foreground', urgent: false }
}

export default function PaymentsPage() {
  const { canDo } = useAuth()
  const [payments, setPayments] = useState<RecurringPayment[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<RecurringPayment | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [payFor, setPayFor] = useState<RecurringPayment | null>(null)

  const load = () => fetchRecurringPayments().then(setPayments).catch(() => toast.error('Ошибка загрузки'))
  useEffect(() => { load().finally(() => setLoading(false)) }, [])

  const manage = canDo('finance.manage')

  const stats = useMemo(() => {
    const active = payments.filter(p => p.active)
    const dueSoon = active.filter(p => { const d = daysUntil(p.nextDue); return d !== null && d <= 7 })
    const overdue = active.filter(p => { const d = daysUntil(p.nextDue); return d !== null && d < 0 })
    return {
      monthly: active.reduce((s, p) => s + p.amount, 0),
      dueSoonTotal: dueSoon.reduce((s, p) => s + p.amount, 0),
      dueSoonCount: dueSoon.length,
      overdueCount: overdue.length,
    }
  }, [payments])

  // Группировка по срочности: плоский список не отвечал на главный вопрос
  // «что платить прямо сейчас» — просроченное тонуло среди будущих платежей.
  const groups = useMemo(() => {
    const overdue: RecurringPayment[] = []
    const thisWeek: RecurringPayment[] = []
    const later: RecurringPayment[] = []
    const paused: RecurringPayment[] = []
    for (const p of payments) {
      if (!p.active) { paused.push(p); continue }
      const d = daysUntil(p.nextDue)
      if (d !== null && d < 0) overdue.push(p)
      else if (d !== null && d <= 7) thisWeek.push(p)
      else later.push(p)
    }
    // Внутри группы — по сроку: чем ближе дата, тем выше.
    const byDue = (a: RecurringPayment, b: RecurringPayment) => (a.nextDue ?? '9999').localeCompare(b.nextDue ?? '9999')
    return [
      { key: 'overdue', title: 'Просрочены', tone: 'text-destructive', items: overdue.sort(byDue) },
      { key: 'week', title: 'На этой неделе', tone: 'text-amber-600', items: thisWeek.sort(byDue) },
      { key: 'later', title: 'Позже', tone: 'text-muted-foreground', items: later.sort(byDue) },
      { key: 'paused', title: 'Приостановлены', tone: 'text-muted-foreground', items: paused.sort(byDue) },
    ].filter(g => g.items.length > 0)
  }, [payments])

  async function toggleActive(p: RecurringPayment) {
    try {
      await updateRecurringPayment(p.id, { active: !p.active })
      await load()
    } catch { toast.error('Не удалось изменить') }
  }

  async function remove(p: RecurringPayment) {
    if (!confirm(`Удалить «${p.name}»?`)) return
    try {
      await deleteRecurringPayment(p.id)
      await load()
      toast.success('Удалено')
    } catch { toast.error('Не удалось удалить') }
  }

  if (loading) return <div className="p-6 flex items-center justify-center h-64"><div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5">
      <FinanceTabs />
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">Платежи</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Регулярные платежи — аренда, коммуналка, оклады</p>
        </div>
        {manage && (
          <button
            onClick={() => setAddOpen(true)}
            className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors w-full sm:w-auto justify-center"
          >
            <Plus className="size-4" />
            Добавить платёж
          </button>
        )}
      </div>

      {/* Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[
          { label: 'К оплате (7 дней)', value: formatCurrency(stats.dueSoonTotal), sub: `${stats.dueSoonCount} платеж(ей)`, icon: CalendarClock, color: stats.dueSoonCount > 0 ? 'text-amber-600' : 'text-muted-foreground' },
          { label: 'Просрочено', value: String(stats.overdueCount), sub: stats.overdueCount > 0 ? 'требуют оплаты' : 'нет', icon: AlertTriangle, color: stats.overdueCount > 0 ? 'text-destructive' : 'text-muted-foreground' },
          { label: 'В месяц всего', value: formatCurrency(stats.monthly), sub: 'по активным', icon: CreditCard, color: 'text-foreground' },
        ].map(s => (
          <div key={s.label} className="bg-card rounded-xl border border-border p-4 flex items-center gap-3">
            <s.icon className={`size-5 ${s.color}`} />
            <div>
              <p className="text-xs text-muted-foreground">{s.label}</p>
              <p className="text-base font-bold text-foreground">{s.value}</p>
              <p className="text-[11px] text-muted-foreground">{s.sub}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Empty */}
      {payments.length === 0 && (
        <div className="bg-card rounded-xl border border-border p-12 text-center">
          <CalendarClock className="size-10 text-muted-foreground/30 mx-auto mb-3" />
          <p className="font-medium text-foreground">Нет регулярных платежей</p>
          <p className="text-sm text-muted-foreground mt-1">Добавьте аренду, коммуналку или оклады — система напомнит о сроке</p>
        </div>
      )}

      {/* Список по группам срочности: сначала просроченное, потом эта неделя */}
      {groups.map(group => (
        <div key={group.key} className="space-y-2">
          <div className="flex items-baseline justify-between gap-3 px-1">
            <h2 className={`text-sm font-semibold ${group.tone}`}>
              {group.title} <span className="text-muted-foreground font-normal">· {group.items.length}</span>
            </h2>
            <span className="text-xs font-medium text-muted-foreground tabular-nums">
              {formatCurrency(group.items.reduce((s, p) => s + p.amount, 0))}
            </span>
          </div>
          {group.items.map(p => {
            const st = dueStatus(p)
            return (
              <div
                key={p.id}
                className={`bg-card rounded-xl border p-4 flex items-center gap-4 ${st.urgent ? 'border-amber-300/60' : 'border-border'} ${!p.active ? 'opacity-60' : ''}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-foreground truncate">{p.name}</span>
                    <span className={`text-[11px] px-2 py-0.5 rounded font-medium ${st.color}`}>{st.label}</span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {p.category ? `${p.category} · ` : ''}каждое {p.dayOfMonth}-е число
                    {p.active && p.nextDue ? ` · след. ${p.nextDue}` : ''}
                  </p>
                </div>
                <span className="font-semibold text-foreground tabular-nums whitespace-nowrap">{formatCurrency(p.amount)}</span>
                {manage && (
                  <div className="flex items-center gap-1 shrink-0">
                    {p.active && (
                      <button
                        onClick={() => setPayFor(p)}
                        className="flex items-center gap-1.5 text-xs font-medium text-primary-foreground bg-primary px-2.5 py-1.5 rounded-lg hover:bg-primary/90 transition-colors"
                      >
                        <CreditCard className="size-3.5" />
                        Оплатить
                      </button>
                    )}
                    <button onClick={() => toggleActive(p)} title={p.active ? 'Приостановить' : 'Возобновить'} className="p-2 text-muted-foreground hover:text-foreground rounded-lg hover:bg-muted transition-colors">
                      {p.active ? <Pause className="size-4" /> : <Play className="size-4" />}
                    </button>
                    <button onClick={() => setEditing(p)} title="Изменить" className="p-2 text-muted-foreground hover:text-foreground rounded-lg hover:bg-muted transition-colors">
                      <Pencil className="size-4" />
                    </button>
                    <button onClick={() => remove(p)} title="Удалить" className="p-2 text-muted-foreground hover:text-destructive rounded-lg hover:bg-muted transition-colors">
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      ))}

      <RecurringPaymentDialog payment={null} open={addOpen} onOpenChange={setAddOpen} onSuccess={load} />
      <RecurringPaymentDialog payment={editing} open={!!editing} onOpenChange={v => { if (!v) setEditing(null) }} onSuccess={load} />
      <PayRecurringDialog payment={payFor} open={!!payFor} onOpenChange={v => { if (!v) setPayFor(null) }} onSuccess={load} />
    </div>
  )
}
