'use client'

import { useState, useEffect, useMemo } from 'react'
import { FinanceTabs } from '@/components/finance/finance-tabs'
import { useAuth } from '@/lib/auth-store'
import {
  fetchMoneyTransfers, createMoneyTransfer, receiveMoneyTransfer, fetchBranches,
  type MoneyTransfer, type Branch,
} from '@/lib/queries/transfers'
import { fetchFinancialAccounts } from '@/lib/queries'
import { selectableAccounts } from '@/lib/queries/finance'
import { type FinancialAccount } from '@/lib/types'
import { formatCurrency } from '@/lib/helpers'
import { humanizeError } from '@/lib/errors'
import { NotInNetwork, isNotInNetwork } from '@/components/network-empty'
import { DecimalInput } from '@/components/ui/decimal-input'
import { Banknote, Plus, ArrowDownLeft, ArrowUpRight, Check, Send } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'

// Переводы денег между узлами сети (ADR-003, Фаза Д): инкассация филиал→центр
// и переброска между филиалами. Двухфазно, как товарное перемещение:
// отправитель списывает со своего счёта, получатель выбирает СВОЙ счёт и
// зачисляет. Между этими двумя моментами деньги «в пути» — не на одном счёте.

const STATUS_LABEL: Record<MoneyTransfer['status'], string> = {
  sent: 'В пути',
  received: 'Получено',
  cancelled: 'Отменено',
}

const STATUS_BADGE: Record<MoneyTransfer['status'], string> = {
  sent: 'bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-400',
  received: 'bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  cancelled: 'bg-rose-100 dark:bg-rose-500/15 text-rose-700 dark:text-rose-400',
}

function fmtDateTime(iso?: string | null): string | null {
  if (!iso) return null
  return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export default function NetworkTransfersPage() {
  const { restaurantId } = useAuth()
  const [transfers, setTransfers] = useState<MoneyTransfer[]>([])
  const [branches, setBranches] = useState<Branch[]>([])
  const [accounts, setAccounts] = useState<FinancialAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [notInNetwork, setNotInNetwork] = useState(false)

  const [sendOpen, setSendOpen] = useState(false)
  const [toId, setToId] = useState('')
  const [fromAccountId, setFromAccountId] = useState('')
  const [amount, setAmount] = useState(0)
  const [note, setNote] = useState('')
  const [sending, setSending] = useState(false)

  // Приём: получатель обязан выбрать, на какой свой счёт зачислить.
  const [receiveFor, setReceiveFor] = useState<MoneyTransfer | null>(null)
  const [toAccountId, setToAccountId] = useState('')
  const [receiving, setReceiving] = useState(false)

  const reload = async () => {
    const [t, b, a] = await Promise.all([fetchMoneyTransfers(), fetchBranches(), fetchFinancialAccounts()])
    setTransfers(t)
    setBranches(b)
    setAccounts(a)
  }

  useEffect(() => {
    reload()
      .catch(e => {
        if (isNotInNetwork(e)) setNotInNetwork(true)
        else toast.error(humanizeError(e))
      })
      .finally(() => setLoading(false))
  }, [])

  const branchName = useMemo(() => {
    const m = new Map(branches.map(b => [b.id, b.name]))
    return (id?: string | null) => (id ? m.get(id) ?? '—' : '—')
  }, [branches])

  const receivers = useMemo(() => branches.filter(b => b.id !== restaurantId), [branches, restaurantId])
  const payable = useMemo(() => selectableAccounts(accounts), [accounts])

  const openSend = () => {
    setToId(receivers[0]?.id ?? '')
    setFromAccountId(payable[0]?.id ?? '')
    setAmount(0)
    setNote('')
    setSendOpen(true)
  }

  const onSend = async () => {
    if (!toId || !fromAccountId || amount <= 0) return
    setSending(true)
    try {
      await createMoneyTransfer({ toRestaurantId: toId, fromAccountId, amount, note: note || undefined })
      toast.success('Деньги отправлены — ждут приёма получателем')
      setSendOpen(false)
      await reload()
    } catch (e: any) {
      toast.error(humanizeError(e))
    } finally {
      setSending(false)
    }
  }

  const openReceive = (t: MoneyTransfer) => {
    setReceiveFor(t)
    // Отправитель мог предложить счёт-назначение (Ф-С2) — предвыбираем его,
    // если он наш и включён; выбор всё равно за принимающим.
    const suggested = t.suggestedToAccountId && payable.some(a => a.id === t.suggestedToAccountId)
      ? t.suggestedToAccountId
      : payable[0]?.id ?? ''
    setToAccountId(suggested)
  }

  const onReceive = async () => {
    if (!receiveFor || !toAccountId) return
    setReceiving(true)
    try {
      await receiveMoneyTransfer(receiveFor.id, toAccountId)
      toast.success('Деньги зачислены на счёт')
      setReceiveFor(null)
      await reload()
    } catch (e: any) {
      toast.error(humanizeError(e))
    } finally {
      setReceiving(false)
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
      <FinanceTabs />

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Banknote className="size-5 text-primary" />
          <h1 className="text-xl font-bold text-foreground">Переводы в сети</h1>
        </div>
        {!notInNetwork && receivers.length > 0 && payable.length > 0 && (
          <button
            onClick={openSend}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Plus className="size-4" /> Отправить
          </button>
        )}
      </div>

      {notInNetwork ? (
        <NotInNetwork what="переводы денег между филиалами" />
      ) : (
        <>
          {transfers.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border p-10 text-center text-muted-foreground">
              <Banknote className="mx-auto mb-2 size-8 opacity-40" />
              Переводов пока нет
            </div>
          ) : (
            <div className="bg-card rounded-xl border border-border overflow-hidden divide-y divide-border">
              {transfers.map(t => {
                const incoming = t.toRestaurantId === restaurantId
                const canReceive = incoming && t.status === 'sent'
                return (
                  <div key={t.id} className="flex items-center gap-3 px-4 py-3.5">
                    {incoming
                      ? <ArrowDownLeft className="size-4 text-emerald-600 shrink-0" />
                      : <ArrowUpRight className="size-4 text-amber-600 shrink-0" />}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-foreground truncate">
                        {t.transferNumber ? `№${t.transferNumber} · ` : ''}
                        {branchName(t.fromRestaurantId)} → {branchName(t.toRestaurantId)}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {t.fromAccountName ? `со счёта «${t.fromAccountName}»` : ''}
                        {fmtDateTime(t.sentAt) ? ` · ${fmtDateTime(t.sentAt)}` : ''}
                        {t.note ? ` · ${t.note}` : ''}
                      </p>
                    </div>
                    <span className="text-sm font-bold text-foreground tabular-nums whitespace-nowrap">
                      {formatCurrency(t.amount)}
                    </span>
                    <div className="flex flex-col items-end gap-1 shrink-0 w-24">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${STATUS_BADGE[t.status]}`}>
                        {STATUS_LABEL[t.status]}
                      </span>
                      {canReceive && (
                        <button
                          type="button"
                          onClick={() => openReceive(t)}
                          className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2 py-1 text-[11px] font-medium text-white hover:opacity-90"
                        >
                          <Check className="size-3" /> Принять
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Деньги списываются сразу при отправке, а зачисляются, когда получатель их примет.
            Пока перевод «в пути», он не лежит ни на одном счёте.
          </p>
        </>
      )}

      {/* Отправка */}
      <Dialog open={sendOpen} onOpenChange={setSendOpen}>
        <DialogContent className="sm:max-w-md rounded-xl">
          <DialogHeader>
            <DialogTitle>Отправить деньги в филиал</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-muted-foreground">Кому</label>
              <select
                value={toId}
                onChange={e => setToId(e.target.value)}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
              >
                {receivers.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-muted-foreground">С какого счёта</label>
              <select
                value={fromAccountId}
                onChange={e => setFromAccountId(e.target.value)}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
              >
                {payable.map(a => (
                  <option key={a.id} value={a.id}>{a.name} — {formatCurrency(a.balance)}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-muted-foreground">Сумма</label>
              {/* DecimalInput не несёт своих стилей — className обязателен на
                  каждом вызове, иначе поле рендерится невидимым. */}
              <DecimalInput
                min={0}
                value={amount}
                onChange={setAmount}
                placeholder="0"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-muted-foreground">Примечание</label>
              <input
                value={note}
                onChange={e => setNote(e.target.value)}
                placeholder="необязательно"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
              />
            </div>
          </div>
          <DialogFooter className="sm:justify-between gap-2">
            <button
              type="button"
              onClick={() => setSendOpen(false)}
              className="px-4 py-2 text-sm font-medium bg-card border border-border rounded-lg hover:bg-muted"
            >
              Отмена
            </button>
            <button
              type="button"
              onClick={onSend}
              disabled={sending || !toId || !fromAccountId || amount <= 0}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium text-primary-foreground bg-primary rounded-lg hover:opacity-90 disabled:opacity-50"
            >
              <Send className="size-4" /> Отправить
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Приём — получатель выбирает свой счёт */}
      <Dialog open={!!receiveFor} onOpenChange={(v) => { if (!v) setReceiveFor(null) }}>
        <DialogContent className="sm:max-w-md rounded-xl">
          <DialogHeader>
            <DialogTitle>Принять деньги</DialogTitle>
          </DialogHeader>
          {receiveFor && (
            <div className="space-y-3 py-1">
              <p className="text-sm text-muted-foreground">
                {branchName(receiveFor.fromRestaurantId)} отправил{' '}
                <span className="font-semibold text-foreground">{formatCurrency(receiveFor.amount)}</span>
                {receiveFor.fromAccountName ? ` со счёта «${receiveFor.fromAccountName}»` : ''}.
              </p>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-muted-foreground">Зачислить на счёт</label>
                <select
                  value={toAccountId}
                  onChange={e => setToAccountId(e.target.value)}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                >
                  {payable.map(a => (
                    <option key={a.id} value={a.id}>{a.name} — {formatCurrency(a.balance)}</option>
                  ))}
                </select>
              </div>
            </div>
          )}
          <DialogFooter className="sm:justify-between gap-2">
            <button
              type="button"
              onClick={() => setReceiveFor(null)}
              className="px-4 py-2 text-sm font-medium bg-card border border-border rounded-lg hover:bg-muted"
            >
              Отмена
            </button>
            <button
              type="button"
              onClick={onReceive}
              disabled={receiving || !toAccountId}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium text-white bg-emerald-600 rounded-lg hover:opacity-90 disabled:opacity-50"
            >
              <Check className="size-4" /> Зачислить
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
