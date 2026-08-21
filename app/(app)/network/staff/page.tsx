'use client'

import { useState, useEffect, useMemo } from 'react'
import { fetchNetworkStaff, payBranchSalary, type NetworkStaff, type NetworkStaffMember } from '@/lib/queries/transfers'
import { fetchFinancialAccounts } from '@/lib/queries'
import { selectableAccounts } from '@/lib/queries/finance'
import { type FinancialAccount } from '@/lib/types'
import { formatCurrency } from '@/lib/helpers'
import { humanizeError } from '@/lib/errors'
import { NotInNetwork, isNotInNetwork } from '@/components/network-empty'
import { ROLE_LABELS } from '@/lib/types'
import { Users, Store, Warehouse, Search, Wallet } from 'lucide-react'
import { toast } from 'sonner'
import { DecimalInput } from '@/components/ui/decimal-input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'

// Персонал сети (ADR-003, Фаза П) — весь штат всех филиалов одним списком на
// центральном узле. Учётки реплицируются с Ф1, но обычный экран сотрудников
// показывает только свой ресторан, поэтому «кто где работает» владелец сети
// раньше нигде не видел.
//
// Только чтение: филиал — авторитет по своим учёткам, правка отсюда была бы
// перезаписана его следующей отправкой данных.

function roleLabel(role: string): string {
  return (ROLE_LABELS as Record<string, string>)[role] ?? role
}

/** Оплата одной строкой: у окладников и дневников это разные величины. */
function payLabel(u: NetworkStaffMember): string {
  if (u.payType === 'daily') {
    return u.dailyRate > 0 ? `${formatCurrency(u.dailyRate)} / день` : '—'
  }
  return u.salary > 0 ? `${formatCurrency(u.salary)} / мес` : '—'
}

/** Текущий месяц как YYYY-MM — период выплаты по умолчанию. */
function currentPeriod(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export default function NetworkStaffPage() {
  const [data, setData] = useState<NetworkStaff | null>(null)
  const [accounts, setAccounts] = useState<FinancialAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notInNetwork, setNotInNetwork] = useState(false)
  const [branchFilter, setBranchFilter] = useState<string>('all')
  const [q, setQ] = useState('')

  // Выплата сотруднику филиала из кассы центра (Фаза Р).
  const [payFor, setPayFor] = useState<NetworkStaffMember | null>(null)
  const [amount, setAmount] = useState(0)
  const [accountId, setAccountId] = useState('')
  const [period, setPeriod] = useState(currentPeriod())
  const [paying, setPaying] = useState(false)

  const reload = () =>
    Promise.all([fetchNetworkStaff(), fetchFinancialAccounts()]).then(([s, a]) => {
      setData(s)
      setAccounts(a)
    })

  useEffect(() => {
    reload()
      .catch(e => {
        if (isNotInNetwork(e)) setNotInNetwork(true)
        else setError(humanizeError(e))
      })
      .finally(() => setLoading(false))
  }, [])

  const payable = useMemo(() => selectableAccounts(accounts), [accounts])

  const openPay = (u: NetworkStaffMember) => {
    setPayFor(u)
    setAmount(u.payType === 'monthly' ? u.salary : 0)
    setAccountId(payable[0]?.id ?? '')
    setPeriod(currentPeriod())
  }

  const onPay = async () => {
    if (!payFor || !accountId || amount <= 0) return
    setPaying(true)
    try {
      await payBranchSalary({
        branchId: payFor.branchId!,
        userId: payFor.id,
        amount,
        accountId,
        period,
      })
      toast.success(`Выплачено: ${payFor.name}`)
      setPayFor(null)
      await reload()
    } catch (e: any) {
      toast.error(humanizeError(e))
    } finally {
      setPaying(false)
    }
  }

  const visible = useMemo(() => {
    const rows = data?.staff ?? []
    const needle = q.trim().toLowerCase()
    return rows.filter(u => {
      if (branchFilter !== 'all' && u.branchId !== branchFilter) return false
      if (!needle) return true
      return (
        u.name.toLowerCase().includes(needle) ||
        roleLabel(u.role).toLowerCase().includes(needle) ||
        (u.position ?? '').toLowerCase().includes(needle)
      )
    })
  }, [data, branchFilter, q])

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-64">
        <div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-4xl">
      <div className="flex items-center gap-2">
        <Users className="size-5 text-primary" />
        <h1 className="text-xl font-bold text-foreground">Персонал сети</h1>
      </div>

      {notInNetwork ? (
        <NotInNetwork what="общий список сотрудников" />
      ) : error ? (
        <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-700">{error}</div>
      ) : (
        <>
          {/* Счётчики по филиалам — они же фильтр списка */}
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setBranchFilter('all')}
              className={`rounded-xl border px-3 py-2 text-left transition-colors ${
                branchFilter === 'all' ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40'
              }`}
            >
              <div className="text-xs text-muted-foreground">Вся сеть</div>
              <div className="text-lg font-bold text-foreground tabular-nums">{data?.totalCount ?? 0}</div>
            </button>
            {(data?.branches ?? []).map(b => (
              <button
                key={b.id}
                onClick={() => setBranchFilter(b.id)}
                className={`rounded-xl border px-3 py-2 text-left transition-colors ${
                  branchFilter === b.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40'
                }`}
              >
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {b.kind === 'central_warehouse'
                    ? <Warehouse className="size-3.5 text-amber-600" />
                    : <Store className="size-3.5" />}
                  {b.name}
                </div>
                <div className="text-lg font-bold text-foreground tabular-nums">{b.count}</div>
              </button>
            ))}
          </div>

          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <input
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Поиск по имени, роли, должности"
              className="w-full rounded-lg border border-border bg-background pl-9 pr-3 py-2 text-sm"
            />
          </div>

          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Сотрудник</th>
                  <th className="px-3 py-2 text-left font-medium">Филиал</th>
                  <th className="px-3 py-2 text-left font-medium">Роль</th>
                  <th className="px-3 py-2 text-right font-medium">Оплата</th>
                  <th className="w-28 px-3 py-2" aria-hidden />
                </tr>
              </thead>
              <tbody>
                {visible.map(u => (
                  <tr key={u.id} className="border-t border-border">
                    <td className="px-3 py-2">
                      <div className="font-medium text-foreground">{u.name || '—'}</div>
                      {(u.position || u.phone) && (
                        <div className="text-xs text-muted-foreground">
                          {[u.position, u.phone].filter(Boolean).join(' · ')}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                        {u.branchKind === 'central_warehouse'
                          ? <Warehouse className="size-3.5 text-amber-600" />
                          : <Store className="size-3.5" />}
                        {u.branchName || '—'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{roleLabel(u.role)}</td>
                    <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{payLabel(u)}</td>
                    <td className="px-3 py-2 text-right">
                      {/* Платить можно только сотрудникам ДРУГИХ узлов: для
                          своих есть обычный экран зарплаты со всей его
                          механикой (табель, авансы, удержания). */}
                      {u.branchKind !== 'central_warehouse' && payable.length > 0 && (
                        <button
                          onClick={() => openPay(u)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-muted transition-colors whitespace-nowrap"
                        >
                          <Wallet className="size-3.5" /> Выплатить
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {visible.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                      {q || branchFilter !== 'all' ? 'Никто не найден' : 'В сети пока нет сотрудников'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-muted-foreground">
            Карточки сотрудников только для просмотра: их заводят и меняют в своём филиале —
            правка отсюда была бы перезаписана при следующей синхронизации. Зарплату при этом
            можно выплатить прямо здесь, из своей кассы.
          </p>
        </>
      )}

      {/* Выплата сотруднику филиала из кассы центра */}
      <Dialog open={!!payFor} onOpenChange={(v) => { if (!v) setPayFor(null) }}>
        <DialogContent className="sm:max-w-md rounded-xl">
          <DialogHeader>
            <DialogTitle>Выплата сотруднику филиала</DialogTitle>
          </DialogHeader>
          {payFor && (
            <div className="space-y-3 py-1">
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{payFor.name}</span> · {payFor.branchName}
                {payFor.payType === 'monthly' && payFor.salary > 0 && <> · оклад {formatCurrency(payFor.salary)}</>}
              </p>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-muted-foreground">Период (месяц начисления)</label>
                <input
                  type="month"
                  value={period}
                  onChange={e => setPeriod(e.target.value)}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-muted-foreground">С какого счёта</label>
                <select
                  value={accountId}
                  onChange={e => setAccountId(e.target.value)}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                >
                  {payable.map(a => (
                    <option key={a.id} value={a.id}>{a.name} — {formatCurrency(a.balance)}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-muted-foreground">Сумма</label>
                <DecimalInput
                  min={0}
                  value={amount}
                  onChange={setAmount}
                  placeholder="0"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Деньги спишутся с вашего счёта, а в отчётах филиала выплата отразится как его
                расход на зарплату — и его касса больше не предложит выплатить это второй раз.
              </p>
            </div>
          )}
          <DialogFooter className="sm:justify-between gap-2">
            <button
              type="button"
              onClick={() => setPayFor(null)}
              className="px-4 py-2 text-sm font-medium bg-card border border-border rounded-lg hover:bg-muted"
            >
              Отмена
            </button>
            <button
              type="button"
              onClick={onPay}
              disabled={paying || !accountId || amount <= 0}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium text-primary-foreground bg-primary rounded-lg hover:opacity-90 disabled:opacity-50"
            >
              <Wallet className="size-4" /> Выплатить
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
