'use client'

import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/lib/auth-store'
import { fetchTransfers, fetchBranches, receiveTransfer, type Transfer, type Branch } from '@/lib/queries/transfers'
import { ArrowLeftRight, Plus, ArrowDownLeft, ArrowUpRight, Check, PackageCheck } from 'lucide-react'
import { toast } from 'sonner'

const STATUS_LABEL: Record<Transfer['status'], string> = {
  draft: 'Черновик',
  sent: 'Отправлено',
  received: 'Принято',
  cancelled: 'Отменено',
}

export default function TransfersPage() {
  const { restaurantId } = useAuth()
  const navigate = useNavigate()
  const [transfers, setTransfers] = useState<Transfer[]>([])
  const [branches, setBranches] = useState<Branch[]>([])
  const [loading, setLoading] = useState(true)
  const [receiving, setReceiving] = useState<string | null>(null)

  const reload = async () => {
    const [t, b] = await Promise.all([fetchTransfers(), fetchBranches()])
    setTransfers(t)
    setBranches(b)
  }

  useEffect(() => {
    reload().finally(() => setLoading(false))
  }, [])

  const branchName = useMemo(() => {
    const m = new Map(branches.map(b => [b.id, b.name]))
    return (id?: string | null) => (id ? m.get(id) ?? '—' : '—')
  }, [branches])

  const onReceive = async (id: string) => {
    setReceiving(id)
    try {
      await receiveTransfer(id)
      toast.success('Перемещение принято')
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
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">№</th>
                <th className="px-3 py-2 text-left font-medium">Откуда → Куда</th>
                <th className="px-3 py-2 text-left font-medium">Позиций</th>
                <th className="px-3 py-2 text-left font-medium">Статус</th>
                <th className="px-3 py-2 text-right font-medium">Действие</th>
              </tr>
            </thead>
            <tbody>
              {transfers.map(t => {
                const incoming = t.toRestaurantId === restaurantId
                const canReceive = incoming && t.status === 'sent'
                return (
                  <tr key={t.id} className="border-t border-border">
                    <td className="px-3 py-2 text-muted-foreground">{t.transferNumber ?? '—'}</td>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-1.5">
                        {incoming ? <ArrowDownLeft className="size-4 text-emerald-600" /> : <ArrowUpRight className="size-4 text-amber-600" />}
                        {branchName(t.fromRestaurantId)} → {branchName(t.toRestaurantId)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{t.lines.length}</td>
                    <td className="px-3 py-2">
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{STATUS_LABEL[t.status]}</span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      {canReceive ? (
                        <button
                          onClick={() => onReceive(t.id)}
                          disabled={receiving === t.id}
                          className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
                        >
                          <Check className="size-3.5" /> Принять
                        </button>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
