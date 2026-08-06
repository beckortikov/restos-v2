'use client'

import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import QRCode from 'qrcode'
import { useAuth } from '@/lib/auth-store'
import {
  fetchNetworkSummary, createNetwork, setBranchKind, type BranchSummary,
  fetchNetworkInvites, createNetworkInvite, revokeNetworkInvite, type NetworkInvite,
} from '@/lib/queries/transfers'
import { Network, Store, Warehouse, Plus, GitMerge, ChevronRight, Ticket, Copy, QrCode, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

export default function BranchesSettingsPage() {
  const { restaurantId } = useAuth()
  const [loading, setLoading] = useState(true)
  const [inNetwork, setInNetwork] = useState(false)
  const [branches, setBranches] = useState<BranchSummary[]>([])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  const isCentral = branches.some(b => b.id === restaurantId && b.kind === 'central_warehouse')

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

          <Link
            to="/warehouse/nomenclature"
            className="flex items-center justify-between rounded-xl border border-border p-3 text-sm hover:bg-muted/50 transition-colors"
          >
            <span className="flex items-center gap-2">
              <GitMerge className="size-4 text-muted-foreground" />
              <span>
                <span className="font-medium text-foreground">Сопоставление товаров</span>
                <span className="block text-xs text-muted-foreground">Разобрать расхождения, если автосопоставление ингредиентов между филиалами не сработало</span>
              </span>
            </span>
            <ChevronRight className="size-4 text-muted-foreground shrink-0" />
          </Link>

          {isCentral && <InvitesSection />}
        </>
      )}
    </div>
  )
}

// InvitesSection — коды приглашения (ADR-003, продолжение): central
// генерирует одноразовый код, филиал вставляет его на своей странице
// «Синхронизация» — без ручного SQL/секретов. Видна только центральному
// складу сети (только он выпускает приглашения).
function InvitesSection() {
  const [invites, setInvites] = useState<NetworkInvite[]>([])
  const [loading, setLoading] = useState(true)
  const [label, setLabel] = useState('')
  const [publicUrl, setPublicUrl] = useState('')
  const [creating, setCreating] = useState(false)
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [qrFor, setQrFor] = useState<string | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState('')

  const reload = useCallback(async () => {
    try {
      const rows = await fetchNetworkInvites()
      setInvites(rows)
      // Подсказка для нового кода — адрес, который уже вводили в прошлый раз.
      if (!publicUrl && rows.length > 0) {
        const lastUrl = rows[0].pairingUrl.replace(/\/pair\/.*$/, '')
        setPublicUrl(lastUrl)
      }
    } catch (e: any) {
      toast.error(e?.message ?? 'Не удалось загрузить приглашения')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    reload().finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onCreate = async () => {
    if (!publicUrl.trim()) {
      toast.error('Укажите публичный адрес этого узла')
      return
    }
    setCreating(true)
    try {
      await createNetworkInvite({ label: label.trim() || undefined, publicUrl: publicUrl.trim() })
      toast.success('Код приглашения создан')
      setLabel('')
      await reload()
    } catch (e: any) {
      toast.error(e?.message ?? 'Не удалось создать код')
    } finally {
      setCreating(false)
    }
  }

  const onRevoke = async (id: string) => {
    setRevokingId(id)
    try {
      await revokeNetworkInvite(id)
      toast.success('Код отозван')
      setInvites(prev => prev.filter(i => i.id !== id))
    } catch (e: any) {
      toast.error(e?.message ?? 'Не удалось отозвать код')
    } finally {
      setRevokingId(null)
    }
  }

  const onCopy = async (invite: NetworkInvite) => {
    try {
      await navigator.clipboard.writeText(invite.pairingUrl)
      toast.success('Скопировано')
    } catch {
      toast.error('Не удалось скопировать')
    }
  }

  const onToggleQr = async (invite: NetworkInvite) => {
    if (qrFor === invite.id) {
      setQrFor(null)
      return
    }
    setQrFor(invite.id)
    try {
      const dataUrl = await QRCode.toDataURL(invite.pairingUrl, { width: 240, margin: 2, errorCorrectionLevel: 'M' })
      setQrDataUrl(dataUrl)
    } catch {
      toast.error('Не удалось построить QR')
      setQrFor(null)
    }
  }

  const statusOf = (i: NetworkInvite): { label: string; className: string } => {
    if (i.usedAt) return { label: `Использован${i.usedByRestaurantName ? ` · ${i.usedByRestaurantName}` : ''}`, className: 'text-muted-foreground' }
    if (new Date(i.expiresAt).getTime() < Date.now()) return { label: 'Истёк', className: 'text-destructive' }
    return { label: 'Активен', className: 'text-emerald-600' }
  }

  return (
    <div className="space-y-3 rounded-xl border border-border p-4">
      <div className="flex items-center gap-2">
        <Ticket className="size-4 text-primary" />
        <h2 className="text-sm font-bold text-foreground">Приглашения филиалов</h2>
      </div>
      <p className="text-xs text-muted-foreground">
        Сгенерируйте код — вставьте его на филиале в Настройках → Синхронизация. Адрес, токен и сеть подставятся сами, без SQL.
        Код одноразовый, действует 7 дней.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-2 items-end">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Метка (для себя)</label>
          <input value={label} onChange={e => setLabel(e.target.value)} placeholder="напр. Филиал на Чехова" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Публичный адрес этого узла</label>
          <input value={publicUrl} onChange={e => setPublicUrl(e.target.value)} placeholder="https://central.example.com" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
        </div>
        <button onClick={onCreate} disabled={creating} className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
          <Plus className="size-4" /> Сгенерировать код
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-4">
          <div className="size-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
        </div>
      ) : invites.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-3">Пока нет ни одного кода</p>
      ) : (
        <div className="space-y-2">
          {invites.map(i => {
            const status = statusOf(i)
            const revocable = !i.usedAt
            return (
              <div key={i.id} className="rounded-lg border border-border p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-foreground truncate">{i.label || i.code}</div>
                    <div className={`text-xs ${status.className}`}>{status.label}</div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => onCopy(i)} title="Копировать" className="inline-flex items-center justify-center size-8 rounded-lg border border-border hover:bg-muted transition-colors">
                      <Copy className="size-3.5" />
                    </button>
                    <button onClick={() => onToggleQr(i)} title="QR-код" className="inline-flex items-center justify-center size-8 rounded-lg border border-border hover:bg-muted transition-colors">
                      <QrCode className="size-3.5" />
                    </button>
                    {revocable && (
                      <button
                        onClick={() => onRevoke(i.id)}
                        disabled={revokingId === i.id}
                        title="Отозвать"
                        className="inline-flex items-center justify-center size-8 rounded-lg border border-border text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    )}
                  </div>
                </div>
                {qrFor === i.id && qrDataUrl && (
                  <div className="flex justify-center py-2">
                    <img src={qrDataUrl} alt="QR код приглашения" className="rounded-lg border border-border" />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
