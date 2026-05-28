'use client'

import { useState, useEffect, useMemo } from 'react'
import { useAuth } from '@/lib/auth-store'
import { DatePeriodFilter, filterByDateRange, type PeriodKey } from '@/components/date-period-filter'
import { formatCurrency } from '@/lib/helpers'
import { type FinancialAccount, type FinancialOperation } from '@/lib/types'
import { fetchFinancialAccounts, fetchFinancialOperations, transferBetweenAccounts, createFinancialAccount, createFinancialOperation } from '@/lib/queries'
import { ArrowDownCircle, ArrowUpCircle, ArrowLeftRight, Plus, Banknote, CreditCard } from 'lucide-react'
import { CreateOperationDialog } from '@/components/dialogs/create-operation-dialog'
import { toast } from 'sonner'
import { DecimalInput } from '@/components/ui/decimal-input'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'

export default function AccountsPage() {
  const { canDo } = useAuth()
  const [selectedAccount, setSelectedAccount] = useState<string>('all')
  const [accounts, setAccounts] = useState<FinancialAccount[]>([])
  const [operations, setOperations] = useState<FinancialOperation[]>([])
  const [loading, setLoading] = useState(true)
  const [operationDialogOpen, setOperationDialogOpen] = useState(false)
  const [addAccountDialogOpen, setAddAccountDialogOpen] = useState(false)
  const [transferDialogOpen, setTransferDialogOpen] = useState(false)
  const [newAccountName, setNewAccountName] = useState('')
  const [newAccountType, setNewAccountType] = useState<'cash' | 'bank'>('bank')
  const [transferFrom, setTransferFrom] = useState('')
  const [transferTo, setTransferTo] = useState('')
  const [transferAmount, setTransferAmount] = useState(0)
  const [period, setPeriod] = useState<PeriodKey>('month')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')

  useEffect(() => {
    Promise.all([fetchFinancialAccounts(), fetchFinancialOperations()])
      .then(([accs, ops]) => { setAccounts(accs); setOperations(ops) })
      .finally(() => setLoading(false))
  }, [])

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
      toast.error(e instanceof Error ? e.message : 'Ошибка создания счёта')
    } finally {
      setAddingSaving(false)
    }
  }

  async function handleCreateOperation(data: { type: 'in' | 'out' | 'transfer'; amount: number; category: string; accountId: string; activity: 'operational' | 'investment' | 'financial'; description: string; date: string }) {
    try {
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
      })
      // Refresh data from DB
      const [accs, ops] = await Promise.all([fetchFinancialAccounts(), fetchFinancialOperations()])
      setAccounts(accs)
      setOperations(ops)
      toast.success('Операция создана')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка создания операции')
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

  if (loading) return <div className="p-6 flex items-center justify-center h-64"><div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>

  const totalBalance = accounts.reduce((s, a) => s + a.balance, 0)

  // Only show operations that have an account (accounting-only ops have account_id=null)
  const filteredOps = filteredByDate.filter(
    (op) => op.accountId && (selectedAccount === 'all' || op.accountId === selectedAccount)
  )

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5">
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
          <p className="text-xs text-muted-foreground mt-1">{accounts.length} счёта</p>
        </button>
        {accounts.map((acc) => {
          const accOps = operations.filter((o) => o.accountId === acc.id)
          const inSum = accOps.filter((o) => o.type === 'in').reduce((s, o) => s + o.amount, 0)
          const outSum = accOps.filter((o) => o.type === 'out').reduce((s, o) => s + o.amount, 0)
          return (
            <button
              key={acc.id}
              onClick={() => setSelectedAccount(acc.id)}
              className={`text-left rounded-xl border p-4 transition-colors ${selectedAccount === acc.id ? 'border-primary bg-primary/5' : 'border-border bg-card hover:bg-muted/30'}`}
            >
              <div className="flex items-center gap-2 mb-2">
                {acc.type === 'cash' ? (
                  <Banknote className="size-4 text-amber-600" />
                ) : (
                  <CreditCard className="size-4 text-blue-600" />
                )}
                <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">{acc.name}</span>
              </div>
              <p className="text-2xl font-bold text-foreground">{formatCurrency(acc.balance)}</p>
              <div className="flex items-center gap-3 mt-1.5 text-xs">
                <span className="text-emerald-600">+{formatCurrency(inSum)}</span>
                <span className="text-destructive">−{formatCurrency(outSum)}</span>
              </div>
            </button>
          )
        })}
      </div>

      {/* Transfer / quick actions */}
      <div className="flex flex-col sm:flex-row gap-2">
        {canDo('finance.manage') && (
          <button
            onClick={() => setOperationDialogOpen(true)}
            className="flex items-center gap-2 bg-card border border-border text-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-muted transition-colors w-full sm:w-auto justify-center"
          >
            <ArrowDownCircle className="size-4 text-emerald-600" />
            Приход
          </button>
        )}
        {canDo('finance.manage') && (
          <button
            onClick={() => setOperationDialogOpen(true)}
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
          {filteredOps.map((op) => (
            <div key={op.id} className="flex items-center gap-4 px-5 py-3 hover:bg-muted/30 transition-colors">
              <div className={`size-8 rounded-full flex items-center justify-center shrink-0 ${op.type === 'in' ? 'bg-emerald-100' : 'bg-red-100'}`}>
                {op.type === 'in' ? (
                  <ArrowDownCircle className="size-4 text-emerald-600" />
                ) : (
                  <ArrowUpCircle className="size-4 text-destructive" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground truncate">{String(op.description || op.category || '')}</p>
                <p className="text-xs text-muted-foreground">{String(op.category || '')} · {String(op.accountName || '')} · {String(op.date || '')}</p>
              </div>
              <span className={`text-sm font-bold shrink-0 ${op.type === 'in' ? 'text-emerald-600' : 'text-destructive'}`}>
                {op.type === 'in' ? '+' : '−'}{formatCurrency(op.amount)}
              </span>
            </div>
          ))}
        </div>
      </div>

      <CreateOperationDialog
        open={operationDialogOpen}
        onOpenChange={setOperationDialogOpen}
        onSubmit={handleCreateOperation}
      />

      {/* Add Account Dialog */}
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
              <select
                value={transferFrom}
                onChange={(e) => setTransferFrom(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                <option value="">Выберите счёт</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} — {formatCurrency(a.balance)}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">На счёт</label>
              <select
                value={transferTo}
                onChange={(e) => setTransferTo(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                <option value="">Выберите счёт</option>
                {accounts.map((a) => (
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
