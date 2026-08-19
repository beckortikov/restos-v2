'use client'

import { FinanceTabs } from '@/components/finance/finance-tabs'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { useDataSync } from '@/hooks/use-data-sync'
import { useAuth } from '@/lib/auth-store'
import { DatePeriodFilter, filterByDateRange, getDateRange, type PeriodKey } from '@/components/date-period-filter'
import { formatCurrency } from '@/lib/helpers'
import { type FinancialAccount, type FinancialOperation, finopCategoryLabel, isOperationEditable } from '@/lib/types'
import { fetchFinancialAccounts, fetchFinancialOperations, transferBetweenAccounts, createFinancialAccount, createFinancialOperation, updateFinancialOperation, updateFinancialAccount, fetchAccountBalanceHistory, type AccountBalanceHistory } from '@/lib/queries'
import { selectableAccounts, setFinancialAccountEnabled } from '@/lib/queries/finance'
import { ArrowDownCircle, ArrowUpCircle, ArrowLeftRight, Plus, Banknote, CreditCard, Pencil, ChevronDown } from 'lucide-react'
import { CreateOperationDialog } from '@/components/dialogs/create-operation-dialog'
import { toast } from 'sonner'
import { humanizeError } from '@/lib/errors'
import { DecimalInput } from '@/components/ui/decimal-input'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'

export default function AccountsPage() {
  const { canDo, user } = useAuth()
  const isOwner = user?.role === 'owner'
  const [selectedAccount, setSelectedAccount] = useState<string>('all')
  const [accounts, setAccounts] = useState<FinancialAccount[]>([])
  const [operations, setOperations] = useState<FinancialOperation[]>([])
  const [loading, setLoading] = useState(true)
  const [operationDialogOpen, setOperationDialogOpen] = useState(false)
  const [editingOperation, setEditingOperation] = useState<FinancialOperation | null>(null)
  const [addAccountDialogOpen, setAddAccountDialogOpen] = useState(false)
  const [transferDialogOpen, setTransferDialogOpen] = useState(false)
  const [newAccountName, setNewAccountName] = useState('')
  // Default = 'cash' (наличные/касса) — большинство ресторанов добавляют сначала
  // основную кассу. Раньше default был 'bank' → юзеры создавали счёт «Касса» с
  // type='bank' и потом /operations/shifts не находил cash-счёт. Fix v2.0.98.
  const [newAccountType, setNewAccountType] = useState<'cash' | 'bank'>('cash')
  const [transferFrom, setTransferFrom] = useState('')
  const [transferTo, setTransferTo] = useState('')
  const [transferAmount, setTransferAmount] = useState(0)
  const [period, setPeriod] = useState<PeriodKey>('month')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  // «Остаток по дням»: за длинный период большинство дней без движения (только
  // перенос остатка). По умолчанию прячем их — показываем лишь дни с приходом/
  // расходом. Тумблер возвращает полный ряд.
  const [hideQuietDays, setHideQuietDays] = useState(true)
  // «Остаток по дням» по умолчанию свёрнут — большинству нужны только карточки
  // счетов; таблицу по дням разворачивают по клику.
  const [showBalanceByDay, setShowBalanceByDay] = useState(false)

  // Edit-account dialog state. Открывается по клику на pencil-иконку
  // в карточке счёта. Позволяет поменять name и/или type (cash ↔ bank).
  // Без этого юзер, случайно создавший «Касса» с type=bank, мог только
  // удалить и пересоздать.
  const [editingAccount, setEditingAccount] = useState<FinancialAccount | null>(null)
  const [editName, setEditName] = useState('')
  const [editType, setEditType] = useState<'cash' | 'bank'>('cash')
  const [editSaving, setEditSaving] = useState(false)
  const [togglingId, setTogglingId] = useState<string | null>(null)

  // История остатков по дням — считает бэк (см. fetchAccountBalanceHistory).
  const [balanceHistory, setBalanceHistory] = useState<AccountBalanceHistory | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)

  const reloadAccounts = useCallback(async () => {
    const [accs, ops] = await Promise.all([fetchFinancialAccounts(), fetchFinancialOperations()])
    setAccounts(accs)
    setOperations(ops)
  }, [])

  // Обновление истории остатков по дням — карточки показывают closingBalance из
  // неё (не acc.balance), поэтому после расхода/прихода/перевода её тоже надо
  // перезапросить, иначе цифра на карточке врёт до смены периода/F5.
  const reloadBalanceHistory = useCallback(async () => {
    if (period === 'all') { setBalanceHistory(null); return }
    const { from, to } = getDateRange(period, customFrom, customTo)
    if (!from || !to) { setBalanceHistory(null); return }
    const ymd = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    try { setBalanceHistory(await fetchAccountBalanceHistory(ymd(from), ymd(to))) }
    catch { /* оставляем прежнее значение — карточка не мигнёт */ }
  }, [period, customFrom, customTo])

  useEffect(() => {
    reloadAccounts().finally(() => setLoading(false))
  }, [reloadAccounts])

  // Live-баланс: приёмка, оплата долга, закрытие смены и операции с другого
  // терминала меняют остатки — без этого цифры на карточках врали до F5.
  const reloadAll = useCallback(async () => { await Promise.all([reloadAccounts(), reloadBalanceHistory()]) }, [reloadAccounts, reloadBalanceHistory])
  useDataSync(['financial_operations', 'financial_accounts', 'cash_shifts'], reloadAll)

  // Перезапрашиваем при смене периода. Для «всё время» истории по дням не
  // строим — ряд был бы неограниченным, а карточки показывают текущий остаток.
  useEffect(() => {
    if (period === 'all') { setBalanceHistory(null); return }
    const { from, to } = getDateRange(period, customFrom, customTo)
    if (!from || !to) { setBalanceHistory(null); return }
    const ymd = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    let cancelled = false
    setHistoryLoading(true)
    fetchAccountBalanceHistory(ymd(from), ymd(to))
      .then(h => { if (!cancelled) setBalanceHistory(h) })
      .catch(() => { if (!cancelled) setBalanceHistory(null) })
      .finally(() => { if (!cancelled) setHistoryLoading(false) })
    return () => { cancelled = true }
  }, [period, customFrom, customTo])

  const [addingSaving, setAddingSaving] = useState(false)

  async function handleAddAccount() {
    if (!newAccountName) return
    setAddingSaving(true)
    try {
      const newAcc = await createFinancialAccount({ name: newAccountName, type: newAccountType })
      setAccounts((prev) => [...prev, newAcc])
      setNewAccountName('')
      setNewAccountType('bank')
      setAddAccountDialogOpen(false)
      toast.success(`Счёт «${newAcc.name}» создан`)
    } catch (e) {
      toast.error(humanizeError(e, 'Ошибка создания счёта'))
    } finally {
      setAddingSaving(false)
    }
  }

  function openEditDialog(acc: FinancialAccount, e: React.MouseEvent) {
    e.stopPropagation()
    setEditingAccount(acc)
    setEditName(acc.name)
    setEditType((acc.type === 'cash' ? 'cash' : 'bank') as 'cash' | 'bank')
  }

  async function handleSaveEdit() {
    if (!editingAccount || !editName) return
    setEditSaving(true)
    try {
      const updated = await updateFinancialAccount(editingAccount.id, {
        name: editName,
        type: editType,
      })
      setAccounts(prev => prev.map(a => a.id === updated.id ? updated : a))
      setEditingAccount(null)
      toast.success(`Счёт «${updated.name}» обновлён`)
    } catch (e) {
      toast.error(humanizeError(e, 'Ошибка обновления'))
    } finally {
      setEditSaving(false)
    }
  }

  // Отключение вместо удаления: строка счёта остаётся, история и остаток целы
  // (остаток продолжает считаться в Балансе), но счёт исчезает из выбора при
  // оплате. Сервер откажет с 409, если счёт держит открытую смену, это
  // последний включённый наличный, или на него настроены регулярные платежи —
  // текст причины показываем как есть.
  async function handleToggleEnabled(acc: FinancialAccount) {
    setTogglingId(acc.id)
    try {
      const updated = await setFinancialAccountEnabled(acc.id, !acc.isEnabled)
      setAccounts(prev => prev.map(a => a.id === updated.id ? updated : a))
      setEditingAccount(null)
      toast.success(updated.isEnabled ? `Счёт «${updated.name}» включён` : `Счёт «${updated.name}» отключён`)
    } catch (e) {
      toast.error(humanizeError(e, 'Не удалось изменить счёт'))
    } finally {
      setTogglingId(null)
    }
  }

  async function handleSaveOperation(data: { type: 'in' | 'out' | 'transfer'; amount: number; category: string; accountId: string; activity: 'operational' | 'investment' | 'financial'; description: string; date: string; affectsShift?: boolean }) {
    const editing = editingOperation
    try {
      if (editing) {
        await updateFinancialOperation(editing.id, {
          type: data.type,
          amount: data.amount,
          category: data.category,
          accountId: data.accountId,
          activity: data.activity,
          date: data.date,
          description: data.description,
          affectsShift: data.affectsShift,
        })
      } else {
        const account = accounts.find((a) => a.id === data.accountId)
        await createFinancialOperation({
          type: data.type,
          amount: data.amount,
          category: data.category,
          accountId: data.accountId,
          accountName: account?.name ?? '',
          activity: data.activity,
          date: data.date,
          description: data.description,
          isAuto: false,
          affectsShift: data.affectsShift,
        })
      }
      // Refresh data from DB (+ история по дням — карточки берут остаток из неё).
      const [accs, ops] = await Promise.all([fetchFinancialAccounts(), fetchFinancialOperations()])
      setAccounts(accs)
      setOperations(ops)
      await reloadBalanceHistory()
      toast.success(editing ? 'Операция изменена' : 'Операция создана')
      setEditingOperation(null)
    } catch (e) {
      toast.error(humanizeError(e, editing ? 'Ошибка изменения операции' : 'Ошибка создания операции'))
    }
  }

  async function handleTransfer() {
    if (!transferFrom || !transferTo || transferAmount <= 0 || transferFrom === transferTo) return
    const fromAcc = accounts.find((a) => a.id === transferFrom)
    const toAcc = accounts.find((a) => a.id === transferTo)
    try {
      await transferBetweenAccounts(transferFrom, transferTo, transferAmount, fromAcc?.name ?? '', toAcc?.name ?? '')
      const [updatedAccounts, updatedOps] = await Promise.all([fetchFinancialAccounts(), fetchFinancialOperations()])
      setAccounts(updatedAccounts)
      setOperations(updatedOps)
      await reloadBalanceHistory()
      toast.success(`Перевод ${transferAmount.toLocaleString()} выполнен`)
    } catch {
      toast.error('Ошибка при переводе')
    }
    setTransferFrom('')
    setTransferTo('')
    setTransferAmount(0)
    setTransferDialogOpen(false)
  }

  const filteredByDate = useMemo(() => filterByDateRange(operations, o => o.date, period, customFrom, customTo), [operations, period, customFrom, customTo])

  // «Остаток по дням»: считаем приход/расход/остаток по каждому дню периода
  // (новые сверху). quiet — день без движения (только перенос остатка).
  const balanceDayRows = useMemo(() => {
    if (!balanceHistory) return [] as { date: string; closing: number; dIn: number; dOut: number; quiet: boolean }[]
    return [...balanceHistory.days].reverse().map(d => {
      const closing = selectedAccount === 'all' ? d.closingBalance : (d.perAccount[selectedAccount] ?? 0)
      const dayOps = filteredByDate.filter(
        o => o.accountId && o.date?.slice(0, 10) === d.date &&
          (selectedAccount === 'all' || o.accountId === selectedAccount),
      )
      const dIn = dayOps.filter(o => o.type === 'in').reduce((s, o) => s + o.amount, 0)
      const dOut = dayOps.filter(o => o.type === 'out').reduce((s, o) => s + o.amount, 0)
      return { date: d.date, closing, dIn, dOut, quiet: dIn === 0 && dOut === 0 }
    })
  }, [balanceHistory, filteredByDate, selectedAccount])
  const quietDaysCount = useMemo(() => balanceDayRows.filter(r => r.quiet).length, [balanceDayRows])
  const visibleDayRows = hideQuietDays ? balanceDayRows.filter(r => !r.quiet) : balanceDayRows

  if (loading) return <div className="p-6 flex items-center justify-center h-64"><div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>

  // Итог тоже периодо-зависимый: на конец выбранного периода, а не «сейчас».
  const totalBalance = period !== 'all' && balanceHistory
    ? balanceHistory.accounts.reduce((s, a) => s + a.closingBalance, 0)
    : accounts.reduce((s, a) => s + a.balance, 0)
  const totalNow = accounts.reduce((s, a) => s + a.balance, 0)

  // Only show operations that have an account (accounting-only ops have account_id=null)
  const filteredOps = filteredByDate.filter(
    (op) => op.accountId && (selectedAccount === 'all' || op.accountId === selectedAccount)
  )

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5">
      <FinanceTabs />
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">Счета и касса</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Остатки и операции по всем счетам</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <DatePeriodFilter period={period} onPeriodChange={setPeriod} customFrom={customFrom} customTo={customTo} onCustomFromChange={setCustomFrom} onCustomToChange={setCustomTo} />
        {canDo('finance.manage') && (
          <button
            onClick={() => setAddAccountDialogOpen(true)}
            className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors w-full sm:w-auto justify-center"
          >
            <Plus className="size-4" />
            Добавить счёт
          </button>
        )}
        </div>
      </div>

      {/* Account cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <button
          onClick={() => setSelectedAccount('all')}
          className={`text-left rounded-xl border p-4 transition-colors ${selectedAccount === 'all' ? 'border-primary bg-primary/5' : 'border-border bg-card hover:bg-muted/30'}`}
        >
          <div className="flex items-center gap-2 mb-2">
            <CreditCard className="size-4 text-muted-foreground" />
            <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Все счета</span>
          </div>
          <p className="text-2xl font-bold text-foreground">{formatCurrency(totalBalance)}</p>
          <p className="text-xs text-muted-foreground mt-1">
            {accounts.length} счёта
            {totalBalance !== totalNow && ` · сейчас ${formatCurrency(totalNow)}`}
          </p>
        </button>
        {accounts.map((acc) => {
          // Движение — ЗА ВЫБРАННЫЙ ПЕРИОД. Раньше здесь стоял `operations`
          // вместо `filteredByDate`: фильтр менял только мелкий список внизу,
          // а крупные суммы на карточках считались по всей истории и на
          // переключение периода не реагировали вообще.
          const accOps = filteredByDate.filter((o) => o.accountId === acc.id)
          const inSum = accOps.filter((o) => o.type === 'in').reduce((s, o) => s + o.amount, 0)
          const outSum = accOps.filter((o) => o.type === 'out').reduce((s, o) => s + o.amount, 0)
          // Остаток на конец периода приходит с бэка (balance — это «сейчас»,
          // по датам он не фильтруется в принципе). Пока не загрузился или
          // период = «всё время» — показываем текущий.
          const summary = balanceHistory?.accounts.find(a => a.accountId === acc.id)
          const shownBalance = period !== 'all' && summary ? summary.closingBalance : acc.balance
          const isHistorical = period !== 'all' && summary && shownBalance !== acc.balance
          return (
            <button
              key={acc.id}
              onClick={() => setSelectedAccount(acc.id)}
              className={`relative text-left rounded-xl border p-4 transition-colors ${selectedAccount === acc.id ? 'border-primary bg-primary/5' : 'border-border bg-card hover:bg-muted/30'} ${acc.isEnabled ? '' : 'opacity-60 border-dashed'}`}
            >
              <div className="flex items-center gap-2 mb-2">
                {acc.type === 'cash' ? (
                  <Banknote className="size-4 text-amber-600" />
                ) : (
                  <CreditCard className="size-4 text-blue-600" />
                )}
                <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">{acc.name}</span>
                {/* Отключённый счёт остаётся на месте — его остаток реален и
                    входит в Баланс, владелец должен видеть, где лежат деньги. */}
                {!acc.isEnabled && (
                  <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground border border-border rounded px-1.5 py-0.5">
                    Отключён
                  </span>
                )}
                {canDo('finance.manage') && (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => openEditDialog(acc, e)}
                    onKeyDown={(e) => { if (e.key === 'Enter') openEditDialog(acc, e as unknown as React.MouseEvent) }}
                    title="Изменить имя/тип"
                    className="ml-auto p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                  >
                    <Pencil className="size-3.5" />
                  </span>
                )}
              </div>
              <p className="text-2xl font-bold text-foreground">{formatCurrency(shownBalance)}</p>
              <div className="flex items-center gap-3 mt-1.5 text-xs">
                <span className="text-emerald-600">+{formatCurrency(inSum)}</span>
                <span className="text-destructive">−{formatCurrency(outSum)}</span>
              </div>
              {isHistorical && (
                <p className="text-[11px] text-muted-foreground mt-1">
                  на конец периода · сейчас {formatCurrency(acc.balance)}
                </p>
              )}
            </button>
          )
        })}
      </div>

      {/* Остаток по дням — «в какой день сколько денег было на счетах».
          Считается на бэке обратным ходом от текущего баланса: колонка
          financial_accounts.balance хранит только состояние «сейчас». */}
      {period !== 'all' && (
        <div className="bg-card rounded-xl border border-border overflow-hidden">
          <div
            role="button"
            tabIndex={0}
            onClick={() => setShowBalanceByDay(v => !v)}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowBalanceByDay(v => !v) } }}
            className={`flex items-center justify-between gap-3 px-4 py-3 cursor-pointer select-none hover:bg-muted/20 transition-colors ${showBalanceByDay ? 'border-b border-border' : ''}`}
          >
            <h2 className="text-sm font-semibold text-foreground">
              Остаток по дням
              {selectedAccount !== 'all' && (
                <span className="text-muted-foreground font-normal">
                  {' · '}{accounts.find(a => a.id === selectedAccount)?.name ?? ''}
                </span>
              )}
            </h2>
            <div className="flex items-center gap-3">
              {historyLoading && <span className="text-xs text-muted-foreground">Загружаем…</span>}
              {showBalanceByDay && quietDaysCount > 0 && (
                <button
                  type="button"
                  onClick={e => { e.stopPropagation(); setHideQuietDays(v => !v) }}
                  className="text-xs font-medium text-muted-foreground hover:text-foreground transition-colors whitespace-nowrap"
                  title="Дни без прихода и расхода — только перенос остатка"
                >
                  {hideQuietDays ? `Показать пустые дни (${quietDaysCount})` : 'Скрыть пустые дни'}
                </button>
              )}
              <ChevronDown className={`size-4 text-muted-foreground transition-transform ${showBalanceByDay ? 'rotate-180' : ''}`} />
            </div>
          </div>
          {!showBalanceByDay ? null : !balanceHistory || balanceHistory.days.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              {historyLoading ? '' : 'Нет данных за период'}
            </p>
          ) : (
            <div className="overflow-x-auto max-h-[26rem] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/30 sticky top-0">
                  <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2 font-medium">Дата</th>
                    <th className="px-4 py-2 font-medium text-right">Приход</th>
                    <th className="px-4 py-2 font-medium text-right">Расход</th>
                    <th className="px-4 py-2 font-medium text-right">Остаток на конец дня</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {visibleDayRows.map(d => (
                    <tr key={d.date} className={`hover:bg-muted/20 ${d.quiet ? 'text-muted-foreground' : ''}`}>
                      <td className="px-4 py-2 whitespace-nowrap">{d.date}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-emerald-600">
                        {d.dIn ? `+${formatCurrency(d.dIn)}` : '—'}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-destructive">
                        {d.dOut ? `−${formatCurrency(d.dOut)}` : '—'}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums font-semibold text-foreground">
                        {formatCurrency(d.closing)}
                      </td>
                    </tr>
                  ))}
                  {visibleDayRows.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-4 py-6 text-center text-sm text-muted-foreground">
                        За период не было движения по счетам
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Transfer / quick actions */}
      <div className="flex flex-col sm:flex-row gap-2">
        {canDo('finance.manage') && (
          <button
            onClick={() => { setEditingOperation(null); setOperationDialogOpen(true) }}
            className="flex items-center gap-2 bg-card border border-border text-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-muted transition-colors w-full sm:w-auto justify-center"
          >
            <ArrowDownCircle className="size-4 text-emerald-600" />
            Приход
          </button>
        )}
        {canDo('finance.manage') && (
          <button
            onClick={() => { setEditingOperation(null); setOperationDialogOpen(true) }}
            className="flex items-center gap-2 bg-card border border-border text-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-muted transition-colors w-full sm:w-auto justify-center"
          >
            <ArrowUpCircle className="size-4 text-destructive" />
            Расход
          </button>
        )}
        {canDo('finance.manage') && (
          <button
            onClick={() => setTransferDialogOpen(true)}
            className="flex items-center gap-2 bg-card border border-border text-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-muted transition-colors w-full sm:w-auto justify-center"
          >
            <ArrowLeftRight className="size-4 text-primary" />
            Перевод
          </button>
        )}
      </div>

      {/* Operations list */}
      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <div className="px-5 py-3 border-b border-border bg-muted/40">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Операции</h2>
        </div>
        <div className="divide-y divide-border">
          {filteredOps.map((op) => {
            const editable = isOwner && isOperationEditable(op)
            return (
              <div
                key={op.id}
                onClick={editable ? () => { setEditingOperation(op); setOperationDialogOpen(true) } : undefined}
                className={`flex items-center gap-4 px-5 py-3 transition-colors ${editable ? 'cursor-pointer hover:bg-muted/40' : 'hover:bg-muted/30'}`}
              >
                <div className={`size-8 rounded-full flex items-center justify-center shrink-0 ${op.type === 'in' ? 'bg-emerald-100' : 'bg-red-100'}`}>
                  {op.type === 'in' ? (
                    <ArrowDownCircle className="size-4 text-emerald-600" />
                  ) : (
                    <ArrowUpCircle className="size-4 text-destructive" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{String(op.description || finopCategoryLabel(op.category) || '')}</p>
                  <p className="text-xs text-muted-foreground">{[finopCategoryLabel(op.category), op.accountName, op.date].filter(Boolean).join(' · ')}</p>
                </div>
                <span className={`text-sm font-bold shrink-0 ${op.type === 'in' ? 'text-emerald-600' : 'text-destructive'}`}>
                  {op.type === 'in' ? '+' : '−'}{formatCurrency(op.amount)}
                </span>
                {editable && <Pencil className="size-3.5 text-muted-foreground shrink-0" />}
              </div>
            )
          })}
        </div>
      </div>

      <CreateOperationDialog
        open={operationDialogOpen}
        onOpenChange={(o) => { setOperationDialogOpen(o); if (!o) setEditingOperation(null) }}
        onSubmit={handleSaveOperation}
        initialOperation={editingOperation}
      />

      {/* Add Account Dialog */}
      {/* Edit-account dialog — изменение имени/типа существующего счёта.
          Открывается по pencil-иконке в карточке. v2.0.99 fix. */}
      <Dialog open={editingAccount !== null} onOpenChange={(o) => !o && setEditingAccount(null)}>
        <DialogContent className="sm:max-w-md rounded-xl">
          <DialogHeader>
            <DialogTitle>Изменить счёт</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Название</label>
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="Название счёта"
                className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Тип</label>
              <div className="flex gap-2">
                {(['cash', 'bank'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setEditType(t)}
                    className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                      editType === t
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-card border-border text-foreground hover:bg-muted'
                    }`}
                  >
                    {t === 'cash' ? 'Наличные (касса)' : 'Банк (безнал)'}
                  </button>
                ))}
              </div>
              {editingAccount && editingAccount.type !== editType && (
                <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 mt-1">
                  ⚠ Меняем тип с «{editingAccount.type === 'cash' ? 'Наличные' : 'Банк'}» на «{editType === 'cash' ? 'Наличные' : 'Банк'}». Баланс и существующие операции сохраняются — меняется только классификация.
                </p>
              )}
            </div>

            {/* Отключение вместо удаления. Удалить счёт нельзя: на него
                ссылаются смены, возвраты, регулярные платежи и вся история
                операций. Отключённый счёт просто перестаёт предлагаться. */}
            {editingAccount && (
              <div className="pt-3 border-t border-border space-y-2">
                {editingAccount.isEnabled ? (
                  <>
                    <p className="text-xs text-muted-foreground">
                      Счёт перестанет предлагаться при оплате и в операциях.
                      История сохранится
                      {editingAccount.balance !== 0 && (
                        <>, остаток {formatCurrency(editingAccount.balance)} продолжит учитываться в Балансе</>
                      )}.
                    </p>
                    <button
                      type="button"
                      onClick={() => handleToggleEnabled(editingAccount)}
                      disabled={togglingId === editingAccount.id}
                      className="w-full px-3 py-2 text-sm font-medium text-destructive bg-card border border-destructive/40 rounded-lg hover:bg-destructive/10 transition-colors disabled:opacity-50 disabled:pointer-events-none"
                    >
                      {togglingId === editingAccount.id ? 'Отключение…' : 'Отключить счёт'}
                    </button>
                  </>
                ) : (
                  <>
                    <p className="text-xs text-muted-foreground">
                      Счёт отключён — не предлагается при оплате и в операциях.
                    </p>
                    <button
                      type="button"
                      onClick={() => handleToggleEnabled(editingAccount)}
                      disabled={togglingId === editingAccount.id}
                      className="w-full px-3 py-2 text-sm font-medium text-foreground bg-card border border-border rounded-lg hover:bg-muted transition-colors disabled:opacity-50 disabled:pointer-events-none"
                    >
                      {togglingId === editingAccount.id ? 'Включение…' : 'Включить счёт'}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <button
              type="button"
              onClick={() => setEditingAccount(null)}
              className="px-4 py-2 text-sm font-medium text-foreground bg-card border border-border rounded-lg hover:bg-muted transition-colors"
            >
              Отмена
            </button>
            <button
              type="button"
              onClick={handleSaveEdit}
              disabled={!editName || editSaving}
              className="px-4 py-2 text-sm font-medium text-primary-foreground bg-primary rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:pointer-events-none"
            >
              {editSaving ? 'Сохранение...' : 'Сохранить'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={addAccountDialogOpen} onOpenChange={setAddAccountDialogOpen}>
        <DialogContent className="sm:max-w-md rounded-xl">
          <DialogHeader>
            <DialogTitle>Новый счёт</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Название</label>
              <input
                type="text"
                value={newAccountName}
                onChange={(e) => setNewAccountName(e.target.value)}
                placeholder="Название счёта"
                className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Тип</label>
              <div className="flex gap-2">
                {(['cash', 'bank'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setNewAccountType(t)}
                    className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                      newAccountType === t
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-card border-border text-foreground hover:bg-muted'
                    }`}
                  >
                    {t === 'cash' ? 'Наличные' : 'Банк'}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <button
              type="button"
              onClick={() => setAddAccountDialogOpen(false)}
              className="px-4 py-2 text-sm font-medium text-foreground bg-card border border-border rounded-lg hover:bg-muted transition-colors"
            >
              Отмена
            </button>
            <button
              type="button"
              onClick={handleAddAccount}
              disabled={!newAccountName || addingSaving}
              className="px-4 py-2 text-sm font-medium text-primary-foreground bg-primary rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:pointer-events-none"
            >
              {addingSaving ? 'Создание...' : 'Добавить'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Transfer Dialog */}
      <Dialog open={transferDialogOpen} onOpenChange={setTransferDialogOpen}>
        <DialogContent className="sm:max-w-md rounded-xl">
          <DialogHeader>
            <DialogTitle>Перевод между счетами</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Со счёта</label>
              {/* Источник — ВСЕ счета, включая отключённые: перевод это штатный
                  способ забрать остаток с выведенного из оборота счёта. */}
              <select
                value={transferFrom}
                onChange={(e) => setTransferFrom(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                <option value="">Выберите счёт</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}{a.isEnabled ? '' : ' (отключён)'} — {formatCurrency(a.balance)}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">На счёт</label>
              {/* А вот получатель — только включённые: заводить новые деньги на
                  отключённый счёт бессмысленно, сервер такой перевод и не примет. */}
              <select
                value={transferTo}
                onChange={(e) => setTransferTo(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                <option value="">Выберите счёт</option>
                {selectableAccounts(accounts).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} — {formatCurrency(a.balance)}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Сумма</label>
              <DecimalInput
                min={0}
                value={transferAmount}
                onChange={(v) => setTransferAmount(v)}
                placeholder="0"
                className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
          </div>
          <DialogFooter>
            <button
              type="button"
              onClick={() => setTransferDialogOpen(false)}
              className="px-4 py-2 text-sm font-medium text-foreground bg-card border border-border rounded-lg hover:bg-muted transition-colors"
            >
              Отмена
            </button>
            <button
              type="button"
              onClick={handleTransfer}
              disabled={!transferFrom || !transferTo || transferAmount <= 0 || transferFrom === transferTo}
              className="px-4 py-2 text-sm font-medium text-primary-foreground bg-primary rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:pointer-events-none"
            >
              Перевести
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
