'use client'

import { useState, useEffect, useMemo } from 'react'
import { fetchNetworkStaff, type NetworkStaff, type NetworkStaffMember } from '@/lib/queries/transfers'
import { formatCurrency } from '@/lib/helpers'
import { humanizeError } from '@/lib/errors'
import { NotInNetwork, isNotInNetwork } from '@/components/network-empty'
import { ROLE_LABELS, type UserRole } from '@/lib/types'
import { Users, Store, Warehouse, Search } from 'lucide-react'

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

export default function NetworkStaffPage() {
  const [data, setData] = useState<NetworkStaff | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notInNetwork, setNotInNetwork] = useState(false)
  const [branchFilter, setBranchFilter] = useState<string>('all')
  const [q, setQ] = useState('')

  useEffect(() => {
    fetchNetworkStaff()
      .then(setData)
      .catch(e => {
        if (isNotInNetwork(e)) setNotInNetwork(true)
        else setError(humanizeError(e))
      })
      .finally(() => setLoading(false))
  }, [])

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
                  </tr>
                ))}
                {visible.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">
                      {q || branchFilter !== 'all' ? 'Никто не найден' : 'В сети пока нет сотрудников'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-muted-foreground">
            Список только для просмотра: сотрудников заводят и меняют в своём филиале — правка
            отсюда была бы перезаписана при следующей синхронизации.
          </p>
        </>
      )}
    </div>
  )
}
