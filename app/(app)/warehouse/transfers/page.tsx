'use client'

import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/lib/auth-store'
import { fetchTransfers, fetchBranches, receiveTransfer, type Transfer, type Branch } from '@/lib/queries/transfers'
import { fetchUsers } from '@/lib/queries/users'
import { formatCurrency, formatNum } from '@/lib/helpers'
import { dMul } from '@/lib/decimal'
import { ArrowLeftRight, Plus, ArrowDownLeft, ArrowUpRight, Check, PackageCheck, ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'

const STATUS_LABEL: Record<Transfer['status'], string> = {
  draft: 'Черновик',
  sent: 'Отправлено',
  received: 'Принято',
  cancelled: 'Отменено',
}

const STATUS_BADGE: Record<Transfer['status'], string> = {
  draft: 'bg-muted text-muted-foreground',
  sent: 'bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-400',
  received: 'bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  cancelled: 'bg-rose-100 dark:bg-rose-500/15 text-rose-700 dark:text-rose-400',
}

function fmtDateTime(iso?: string | null): string | null {
  if (!iso) return null
  return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export default function TransfersPage() {
  const { restaurantId } = useAuth()
  const navigate = useNavigate()
  const [transfers, setTransfers] = useState<Transfer[]>([])
  const [branches, setBranches] = useState<Branch[]>([])
  const [userNames, setUserNames] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(true)
  const [receiving, setReceiving] = useState<string | null>(null)
  const [detailFor, setDetailFor] = useState<Transfer | null>(null)

  const reload = async () => {
    const [t, b, users] = await Promise.all([fetchTransfers(), fetchBranches(), fetchUsers()])
    setTransfers(t)
    setBranches(b)
    // Пользователи другой стороны перемещения (не своего ресторана) сюда не
    // попадут — учётки не реплицируются между филиалами. userName() ниже
    // корректно откатывается на «—» в этом случае.
    setUserNames(new Map(users.map(u => [u.id, u.name])))
  }

  useEffect(() => {
    reload().finally(() => setLoading(false))
  }, [])

  const branchName = useMemo(() => {
    const m = new Map(branches.map(b => [b.id, b.name]))
    return (id?: string | null) => (id ? m.get(id) ?? '—' : '—')
  }, [branches])

  const userName = (id?: string | null) => (id ? userNames.get(id) ?? '—' : '—')

  const onReceive = async (id: string) => {
    setReceiving(id)
    try {
      await receiveTransfer(id)
      toast.success('Перемещение принято')
      setDetailFor(null)
      await reload()
    } catch (e: any) {
      toast.error(e?.message ?? 'Не удалось принять')
    } finally {
      setReceiving(null)
    }
  }

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-64">
        <div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ArrowLeftRight className="size-5 text-primary" />
          <h1 className="text-xl font-bold text-foreground">Перемещения</h1>
        </div>
        <button
          onClick={() => navigate('/warehouse/transfers/new')}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <Plus className="size-4" /> Создать
        </button>
      </div>

      {transfers.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center text-muted-foreground">
          <PackageCheck className="mx-auto mb-2 size-8 opacity-40" />
          Перемещений пока нет
        </div>
      ) : (
        <div className="bg-card rounded-xl border border-border overflow-hidden divide-y divide-border">
          {transfers.map(t => {
            const incoming = t.toRestaurantId === restaurantId
            const canReceive = incoming && t.status === 'sent'
            const lineTotal = t.lines.reduce((s, l) => s + dMul(l.qty, l.costPerUnit), 0)
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setDetailFor(t)}
                className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-muted/40 transition-colors"
              >
                {incoming ? <ArrowDownLeft className="size-4 text-emerald-600 shrink-0" /> : <ArrowUpRight className="size-4 text-amber-600 shrink-0" />}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-foreground truncate">
                    {t.transferNumber ? `№${t.transferNumber} · ` : ''}{branchName(t.fromRestaurantId)} → {branchName(t.toRestaurantId)}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {t.lines.length} поз. · {formatCurrency(lineTotal)}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${STATUS_BADGE[t.status]}`}>{STATUS_LABEL[t.status]}</span>
                  {canReceive && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onReceive(t.id) }}
                      disabled={receiving === t.id}
                      className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2 py-1 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-50"
                    >
                      <Check className="size-3" /> Принять
                    </button>
                  )}
                </div>
                <ChevronRight className="size-4 text-muted-foreground shrink-0" />
              </button>
            )
          })}
        </div>
      )}

      {/* Детали перемещения — позиции, себестоимость, кто отправил/принял */}
      <Dialog open={!!detailFor} onOpenChange={(v) => { if (!v) setDetailFor(null) }}>
        <DialogContent className="sm:max-w-2xl rounded-xl max-h-[88vh] overflow-y-auto">
          {detailFor && (() => {
            const t = detailFor
            const incoming = t.toRestaurantId === restaurantId
            const canReceive = incoming && t.status === 'sent'
            const total = t.lines.reduce((s, l) => s + dMul(l.qty, l.costPerUnit), 0)
            return (
              <>
                <DialogHeader>
                  <DialogTitle>
                    {t.transferNumber ? `Перемещение №${t.transferNumber}` : 'Перемещение'}
                  </DialogTitle>
                </DialogHeader>
                <div className="space-y-3 py-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                    <span className="inline-flex items-center gap-1.5 text-foreground font-medium">
                      {branchName(t.fromRestaurantId)} <ArrowUpRight className="size-3.5" /> {branchName(t.toRestaurantId)}
                    </span>
                    <span className={`text-[11px] px-1.5 py-0.5 rounded font-medium ${STATUS_BADGE[t.status]}`}>{STATUS_LABEL[t.status]}</span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    {fmtDateTime(t.sentAt) && <p>Отправлено {fmtDateTime(t.sentAt)}, {userName(t.createdBy)}</p>}
                    {t.status === 'received' && fmtDateTime(t.receivedAt) && <p>Принято {fmtDateTime(t.receivedAt)}, {userName(t.receivedBy)}</p>}
                  </div>
                  {t.note && <p className="text-xs text-muted-foreground">Примечание: {t.note}</p>}

                  {/* Позиции */}
                  <div className="rounded-lg border border-border overflow-hidden divide-y divide-border">
                    {t.lines.map((line) => (
                      <div key={line.id} className="flex items-center gap-3 px-3 py-2">
                        <span className="text-sm text-foreground flex-1 truncate">{line.ingredientName || '—'}</span>
                        <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                          {formatNum(line.qty)} {line.unit} × {formatCurrency(line.costPerUnit)}
                        </span>
                        <span className="text-sm font-semibold text-foreground tabular-nums w-24 text-right">{formatCurrency(dMul(line.qty, line.costPerUnit))}</span>
                      </div>
                    ))}
                    <div className="flex items-center justify-between px-3 py-2 bg-muted/30">
                      <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Итого</span>
                      <span className="text-sm font-bold text-foreground tabular-nums">{formatCurrency(total)}</span>
                    </div>
                  </div>
                </div>
                <DialogFooter className="sm:justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => setDetailFor(null)}
                    className="px-4 py-2 text-sm font-medium bg-card border border-border rounded-lg hover:bg-muted"
                  >
                    Закрыть
                  </button>
                  {canReceive && (
                    <button
                      type="button"
                      onClick={() => onReceive(t.id)}
                      disabled={receiving === t.id}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium text-white bg-emerald-600 rounded-lg hover:opacity-90 disabled:opacity-50"
                    >
                      <Check className="size-4" /> Принять перемещение
                    </button>
                  )}
                </DialogFooter>
              </>
            )
          })()}
        </DialogContent>
      </Dialog>
    </div>
  )
}
