'use client'

import { useState, useEffect, useCallback } from 'react'
import { fetchNetworkSummary, createNetwork, setBranchKind, type BranchSummary } from '@/lib/queries/transfers'
import { Network, Store, Warehouse, Plus } from 'lucide-react'
import { toast } from 'sonner'

export default function BranchesSettingsPage() {
  const [loading, setLoading] = useState(true)
  const [inNetwork, setInNetwork] = useState(false)
  const [branches, setBranches] = useState<BranchSummary[]>([])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    try {
      const s = await fetchNetworkSummary()
      setInNetwork(true)
      setBranches(s.branches)
    } catch {
      setInNetwork(false)
      setBranches([])
    }
  }, [])

  useEffect(() => {
    reload().finally(() => setLoading(false))
  }, [reload])

  const onCreate = async () => {
    setBusy(true)
    try {
      await createNetwork(name.trim() || undefined)
      toast.success('Сеть создана — этот ресторан теперь центральный склад')
      setName('')
      await reload()
    } catch (e: any) {
      toast.error(e?.message ?? 'Не удалось создать сеть')
    } finally {
      setBusy(false)
    }
  }

  const onKind = async (id: string, kind: 'outlet' | 'central_warehouse') => {
    try {
      await setBranchKind(id, kind)
      toast.success('Тип филиала обновлён')
      await reload()
    } catch (e: any) {
      toast.error(e?.message ?? 'Не удалось изменить тип')
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
    <div className="p-4 md:p-6 space-y-5 max-w-3xl">
      <div className="flex items-center gap-2">
        <Network className="size-5 text-primary" />
        <h1 className="text-xl font-bold text-foreground">Филиалы сети</h1>
      </div>

      {!inNetwork ? (
        <div className="space-y-3 rounded-xl border border-border p-4">
          <p className="text-sm text-muted-foreground">
            Ресторан пока не в сети. Создайте сеть — этот ресторан станет её центральным складом.
            Остальные филиалы присоединяются к сети на своей установке (через лицензию).
          </p>
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Название сети</label>
              <input value={name} onChange={e => setName(e.target.value)} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" placeholder="напр. Моя сеть" />
            </div>
            <button onClick={onCreate} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
              <Plus className="size-4" /> Создать сеть
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">Филиалы сети и их тип. Центральный склад — точка, с которой идут перемещения.</p>
          <div className="overflow-hidden rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Филиал</th>
                  <th className="px-3 py-2 text-left font-medium">Тип</th>
                </tr>
              </thead>
              <tbody>
                {branches.map(b => (
                  <tr key={b.id} className="border-t border-border">
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-1.5">
                        {b.kind === 'central_warehouse'
                          ? <Warehouse className="size-4 text-amber-600" />
                          : <Store className="size-4 text-muted-foreground" />}
                        {b.name}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <select
                        value={b.kind ?? 'outlet'}
                        onChange={e => onKind(b.id, e.target.value as 'outlet' | 'central_warehouse')}
                        className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
                      >
                        <option value="outlet">Филиал</option>
                        <option value="central_warehouse">Центральный склад</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
