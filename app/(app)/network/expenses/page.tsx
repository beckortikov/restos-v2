'use client'

import { useState, useEffect, useMemo } from 'react'
import {
  fetchBranches, fetchBranchPayables, payBranchExpense,
  fetchBranchExpenses, cancelBranchExpense,
  type Branch, type BranchPayable, type BranchExpense,
} from '@/lib/queries/transfers'
import { fetchFinancialAccounts } from '@/lib/queries'
import { selectableAccounts } from '@/lib/queries/finance'
import { useAuth } from '@/lib/auth-store'
import { type FinancialAccount, finopCategoryLabel } from '@/lib/types'
import { formatCurrency } from '@/lib/helpers'
import { humanizeError } from '@/lib/errors'
import { NotInNetwork, isNotInNetwork } from '@/components/network-empty'
import { DecimalInput } from '@/components/ui/decimal-input'
import { Wallet, Store, FileText, CalendarClock, Plus, Undo2 } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'

// Расходы за филиалы (ADR-003, Фаза Р). Владелец платит из СВОЕЙ кассы за
// филиал: долг поставщику, регулярный платёж или произвольный расход.
//
// Деньги уходят отсюда (видно в ДДС центра), а затрата принадлежит филиалу и
// попадает в ЕГО ОПиУ — иначе центр, который платит за всю сеть, выглядел бы
// убыточным, а филиалы неправдоподобно прибыльными. При оплате долга или
// регулярного платежа филиал ещё и доводит своё состояние: гасит долг по
// накладной, двигает срок следующего платежа.

const KIND_ICON = {
  receipt: FileText,
  recurring: CalendarClock,
} as const

function fmtDue(iso?: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' })
}

export default function NetworkExpensesPage() {
  const { restaurantId } = useAuth()
  const [branches, setBranches] = useState<Branch[]>([])
  const [accounts, setAccounts] = useState<FinancialAccount[]>([])
  const [branchId, setBranchId] = useState('')
  const [payables, setPayables] = useState<BranchPayable[]>([])
  const [expenses, setExpenses] = useState<BranchExpense[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingPayables, setLoadingPayables] = useState(false)
  const [notInNetwork, setNotInNetwork] = useState(false)

  // Оплата: либо привязанная к документу, либо произвольная (payable = null).
  const [payFor, setPayFor] = useState<BranchPayable | null>(null)
  const [freeOpen, setFreeOpen] = useState(false)
  const [amount, setAmount] = useState(0)
  const [accountId, setAccountId] = useState('')
  const [category, setCategory] = useState('')
  const [note, setNote] = useState('')
  const [paying, setPaying] = useState(false)
  const [cancelFor, setCancelFor] = useState<BranchExpense | null>(null)
  const [cancelling, setCancelling] = useState(false)

  useEffect(() => {
    Promise.all([fetchBranches(), fetchFinancialAccounts()])
      .then(([b, a]) => {
        setBranches(b)
        setAccounts(a)
        const first = b.find(x => x.id !== restaurantId)
        if (first) setBranchId(first.id)
      })
      .catch(e => {
        if (isNotInNetwork(e)) setNotInNetwork(true)
        else toast.error(humanizeError(e))
      })
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restaurantId])

  const reloadPayables = (id: string) => {
    if (!id) return Promise.resolve()
    setLoadingPayables(true)
    return fetchBranchPayables(id)
      .then(setPayables)
      .catch(e => toast.error(humanizeError(e)))
      .finally(() => setLoadingPayables(false))
  }

  const reloadExpenses = (id: string) => {
    if (!id) return Promise.resolve()
    return fetchBranchExpenses(id)
      .then(setExpenses)
      .catch(e => toast.error(humanizeError(e)))
  }

  useEffect(() => {
    reloadPayables(branchId)
    reloadExpenses(branchId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId])

  const others = useMemo(() => branches.filter(b => b.id !== restaurantId), [branches, restaurantId])
  const payable = useMemo(() => selectableAccounts(accounts), [accounts])
  const branchName = useMemo(
    () => others.find(b => b.id === branchId)?.name ?? '',
    [others, branchId],
  )

  const openPay = (p: BranchPayable) => {
    setPayFor(p)
    setAmount(p.amount)
    setAccountId(payable[0]?.id ?? '')
    setNote('')
  }
  const openFree = () => {
    setFreeOpen(true)
    setAmount(0)
    setAccountId(payable[0]?.id ?? '')
    setCategory('')
    setNote('')
  }

  const onPay = async () => {
    if (!accountId || amount <= 0) return
    if (!payFor && !category.trim()) return
    setPaying(true)
    try {
      await payBranchExpense({
        branchId,
        accountId,
        amount,
        ...(payFor
          ? { payableKind: payFor.kind, payableId: payFor.id }
          : { category: category.trim() }),
        ...(note.trim() ? { description: note.trim() } : {}),
      })
      // Деньги списались здесь и сейчас, а долг/срок уменьшит САМ филиал, когда
      // получит зеркало (ближайшая синхронизация). Без этой оговорки владелец
      // видит в списке прежнюю сумму и решает, что оплата не прошла.
      toast.success(
        payFor
          ? `Оплачено за «${branchName}». Сумма уже списана с вашего счёта; у филиала обновится после ближайшей синхронизации.`
          : `Оплачено за «${branchName}»`,
      )
      setPayFor(null)
      setFreeOpen(false)
      // Счета перечитываем тоже: с них только что списали, и в следующем
      // диалоге остаток должен быть настоящим, а не тем, что загрузился при
      // открытии страницы.
      await Promise.all([
        reloadPayables(branchId),
        reloadExpenses(branchId),
        fetchFinancialAccounts().then(setAccounts),
      ])
    } catch (e: any) {
      toast.error(humanizeError(e))
    } finally {
      setPaying(false)
    }
  }

  const onCancel = async () => {
    if (!cancelFor) return
    setCancelling(true)
    try {
      await cancelBranchExpense(cancelFor.id)
      // Деньги вернулись сюда сразу; долг накладной и срок регулярного платежа
      // откатит сам филиал, получив отмену — то же правило, что и при оплате.
      toast.success(
        `Расход отменён, ${formatCurrency(cancelFor.amount)} вернулись на счёт. ` +
        'У филиала откатится после ближайшей синхронизации.',
      )
      setCancelFor(null)
      await Promise.all([
        reloadPayables(branchId),
        reloadExpenses(branchId),
        fetchFinancialAccounts().then(setAccounts),
      ])
    } catch (e: any) {
      toast.error(humanizeError(e))
    } finally {
      setCancelling(false)
    }
  }

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-64">
        <div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    )
  }

  const dialogOpen = !!payFor || freeOpen

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-3xl">
      <div className="flex items-center gap-2">
        <Wallet className="size-5 text-primary" />
        <h1 className="text-xl font-bold text-foreground">Расходы за филиалы</h1>
      </div>

      {notInNetwork ? (
        <NotInNetwork what="оплату расходов филиалов" />
      ) : others.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          В сети пока нет филиалов, за которые можно платить.
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Деньги спишутся с вашего счёта, а расход отразится у филиала — в его ОПиУ, но не в его
            ДДС: его касса не пустела. Суммы в списке приходят от филиала, поэтому после оплаты они
            обновятся не сразу, а с ближайшей синхронизацией.
          </p>

          <div className="flex flex-wrap items-end justify-between gap-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-muted-foreground">Филиал</label>
              <select
                value={branchId}
                onChange={e => setBranchId(e.target.value)}
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
              >
                {others.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            {payable.length > 0 && (
              <button
                onClick={openFree}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
              >
                <Plus className="size-4" /> Другой расход
              </button>
            )}
          </div>

          {loadingPayables ? (
            <div className="flex justify-center py-6">
              <div className="size-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
            </div>
          ) : payables.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              <Store className="mx-auto mb-2 size-7 opacity-40" />
              У этого филиала нет ни долгов поставщикам, ни регулярных платежей.
              Разовый расход можно оплатить кнопкой «Другой расход».
            </div>
          ) : (
            <div className="bg-card rounded-xl border border-border overflow-hidden divide-y divide-border">
              {payables.map(p => {
                const Icon = KIND_ICON[p.kind]
                const due = fmtDue(p.dueDate)
                return (
                  <div key={`${p.kind}:${p.id}`} className="flex items-center gap-3 px-4 py-3.5">
                    <Icon className="size-4 text-muted-foreground shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-foreground truncate">{p.title}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {[
                          p.counterparty,
                          p.category ? finopCategoryLabel(p.category) : null,
                          due ? (p.kind === 'recurring' ? `срок ${due}` : `до ${due}`) : null,
                        ].filter(Boolean).join(' · ') || (p.kind === 'receipt' ? 'долг поставщику' : 'регулярный платёж')}
                      </p>
                    </div>
                    <span className="text-sm font-bold text-foreground tabular-nums whitespace-nowrap">
                      {formatCurrency(p.amount)}
                    </span>
                    {payable.length > 0 && (
                      <button
                        onClick={() => openPay(p)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-muted transition-colors whitespace-nowrap shrink-0"
                      >
                        <Wallet className="size-3.5" /> Оплатить
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {expenses.length > 0 && (
            <div className="space-y-2">
              <h2 className="text-sm font-semibold text-foreground">Оплачено за филиал</h2>
              <div className="bg-card rounded-xl border border-border overflow-hidden divide-y divide-border">
                {expenses.map(e => {
                  const off = !!e.cancelledAt
                  return (
                    <div key={e.id} className={`flex items-center gap-3 px-4 py-3 ${off ? 'opacity-60' : ''}`}>
                      <div className="min-w-0 flex-1">
                        <p className={`text-sm font-medium truncate ${off ? 'text-muted-foreground line-through' : 'text-foreground'}`}>
                          {e.description || (e.category ? finopCategoryLabel(e.category) : 'Расход')}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">
                          {[fmtDue(e.date), e.counterparty, e.accountName].filter(Boolean).join(' · ')}
                        </p>
                      </div>
                      <span className={`text-sm font-bold tabular-nums whitespace-nowrap ${off ? 'text-muted-foreground line-through' : 'text-foreground'}`}>
                        {formatCurrency(e.amount)}
                      </span>
                      {off ? (
                        <span className="text-xs text-muted-foreground whitespace-nowrap shrink-0">Отменён</span>
                      ) : (
                        <button
                          onClick={() => setCancelFor(e)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-muted transition-colors whitespace-nowrap shrink-0"
                        >
                          <Undo2 className="size-3.5" /> Отменить
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </>
      )}

      <Dialog open={dialogOpen} onOpenChange={(v) => { if (!v) { setPayFor(null); setFreeOpen(false) } }}>
        <DialogContent className="sm:max-w-md rounded-xl">
          <DialogHeader>
            <DialogTitle>{payFor ? 'Оплатить за филиал' : 'Расход за филиал'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <p className="text-sm text-muted-foreground">
              {payFor
                ? <><span className="font-medium text-foreground">{payFor.title}</span>{payFor.counterparty ? ` · ${payFor.counterparty}` : ''} · {branchName}</>
                : <>Разовый расход за <span className="font-medium text-foreground">{branchName}</span></>}
            </p>

            {!payFor && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-muted-foreground">Статья расхода</label>
                <input
                  value={category}
                  onChange={e => setCategory(e.target.value)}
                  placeholder="напр. Реклама, Коммунальные"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                />
              </div>
            )}

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
              {payFor?.kind === 'receipt' && (
                <p className="text-xs text-muted-foreground">
                  Можно погасить часть долга — остаток останется за филиалом.
                </p>
              )}
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
              onClick={() => { setPayFor(null); setFreeOpen(false) }}
              className="px-4 py-2 text-sm font-medium bg-card border border-border rounded-lg hover:bg-muted"
            >
              Отмена
            </button>
            <button
              type="button"
              onClick={onPay}
              disabled={paying || !accountId || amount <= 0 || (!payFor && !category.trim())}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium text-primary-foreground bg-primary rounded-lg hover:opacity-90 disabled:opacity-50"
            >
              <Wallet className="size-4" /> Оплатить
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={!!cancelFor} onOpenChange={(v) => { if (!v) setCancelFor(null) }}>
        <DialogContent className="sm:max-w-md rounded-xl">
          <DialogHeader>
            <DialogTitle>Отменить расход?</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-1 text-sm text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">
                {cancelFor?.description || (cancelFor?.category ? finopCategoryLabel(cancelFor.category) : 'Расход')}
              </span>
              {' · '}{formatCurrency(cancelFor?.amount ?? 0)}{' · '}{branchName}
            </p>
            <p>
              {formatCurrency(cancelFor?.amount ?? 0)} вернутся на счёт
              {cancelFor?.accountName ? ` «${cancelFor.accountName}»` : ''}. У филиала расход
              пометится отменённым, а если он гасил долг по накладной или двигал срок
              регулярного платежа — то и это откатится, с ближайшей синхронизацией.
            </p>
          </div>
          <DialogFooter className="sm:justify-between gap-2">
            <button
              type="button"
              onClick={() => setCancelFor(null)}
              className="px-4 py-2 text-sm font-medium bg-card border border-border rounded-lg hover:bg-muted"
            >
              Не отменять
            </button>
            <button
              type="button"
              onClick={onCancel}
              disabled={cancelling}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium text-white bg-destructive rounded-lg hover:opacity-90 disabled:opacity-50"
            >
              <Undo2 className="size-4" /> Отменить расход
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
