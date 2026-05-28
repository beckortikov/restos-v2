'use client'

import { useState, useEffect, useMemo } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  type FinancialActivity,
  type FinancialOperationType,
  type FinancialAccount,
} from '@/lib/types'
import { fetchFinancialAccounts, fetchCustomCategories, createCustomCategory } from '@/lib/queries'
import { DecimalInput } from '@/components/ui/decimal-input'

const INCOME_CATEGORIES = [
  'Выручка от реализации',
  'Возврат от поставщика',
  'Вклад учредителя',
  'Инвестиции',
  'Займ полученный',
  'Возврат займа выданного',
  'Прочие поступления',
]

const EXPENSE_CATEGORIES = [
  'Закупка продуктов',
  'Закупка хозтоваров',
  'Аренда',
  'Коммунальные платежи',
  'Оплата труда',
  'Маркетинг и реклама',
  'Комиссия банка',
  'Ремонт и обслуживание',
  'Транспортные расходы',
  'Списание',
  'Покупка оборудования',
  'Дивиденды',
  'Возврат займа',
  'Налоги и сборы',
  'Прочие затраты',
]

interface OperationForm {
  type: FinancialOperationType
  amount: number
  category: string
  accountId: string
  activity: FinancialActivity
  description: string
  date: string
}

interface CreateOperationDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (operation: OperationForm) => void
}

export function CreateOperationDialog({ open, onOpenChange, onSubmit }: CreateOperationDialogProps) {
  const today = new Date().toISOString().split('T')[0]
  const [form, setForm] = useState<OperationForm>({
    type: 'out',
    amount: 0,
    category: '',
    accountId: '',
    activity: 'operational',
    description: '',
    date: today,
  })
  const [customCategory, setCustomCategory] = useState(false)
  const [accounts, setAccounts] = useState<FinancialAccount[]>([])
  const [dbCategories, setDbCategories] = useState<{ name: string; type: string }[]>([])
  const [dataLoaded, setDataLoaded] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      // Always re-fetch accounts when dialog opens (accounts may have been added)
      fetchFinancialAccounts()
        .then(accs => setAccounts(accs))
        .catch(() => {})
      // Custom categories — may fail on older desktop versions, non-blocking
      if (!dataLoaded) {
        fetchCustomCategories()
          .then(cats => { setDbCategories(cats); setDataLoaded(true) })
          .catch(() => setDataLoaded(true))
      }
    }
    if (open) {
      setForm({
        type: 'out', amount: 0, category: '', accountId: '',
        activity: 'operational', description: '', date: today,
      })
      setCustomCategory(false)
      setSaving(false)
    }
  }, [open])

  const categories = useMemo(() => {
    const base = form.type === 'in' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES
    const custom = dbCategories.filter(c => c.type === form.type).map(c => c.name)
    return [...base, ...custom.filter(c => !base.includes(c))]
  }, [form.type, dbCategories])

  async function handleSubmit() {
    setSaving(true)
    // Save custom category to DB if entered manually
    if (customCategory && form.category.trim()) {
      const base = form.type === 'in' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES
      if (!base.includes(form.category.trim())) {
        try {
          await createCustomCategory(form.category.trim(), form.type as 'in' | 'out')
          setDbCategories(prev => [...prev, { name: form.category.trim(), type: form.type }])
        } catch {}
      }
    }
    try {
      await onSubmit(form)
      onOpenChange(false)
    } catch {
      setSaving(false)
    }
  }

  const canSubmit = form.amount > 0 && form.category && form.accountId && !saving

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto rounded-xl">
        <DialogHeader>
          <DialogTitle>Новая операция</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Type */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Тип</label>
            <div className="flex gap-2">
              {(['in', 'out'] as FinancialOperationType[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setForm((p) => ({ ...p, type: t, category: '' }))}
                  className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                    form.type === t
                      ? t === 'in'
                        ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30'
                        : 'bg-red-500/10 text-red-600 border-red-500/30'
                      : 'bg-card border-border text-foreground hover:bg-muted'
                  }`}
                >
                  {t === 'in' ? 'Приход' : 'Расход'}
                </button>
              ))}
            </div>
          </div>

          {/* Amount */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Сумма</label>
            <DecimalInput
              value={form.amount}
              onChange={(v) => setForm((p) => ({ ...p, amount: v }))}
              min={0}
              placeholder="0"
              className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          {/* Category */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-foreground">Категория</label>
              <button
                type="button"
                onClick={() => {
                  setCustomCategory(!customCategory)
                  setForm((p) => ({ ...p, category: '' }))
                }}
                className="text-xs text-primary hover:text-primary/80 transition-colors"
              >
                {customCategory ? 'Из списка' : 'Своя'}
              </button>
            </div>
            {customCategory ? (
              <input
                type="text"
                value={form.category}
                onChange={(e) => setForm((p) => ({ ...p, category: e.target.value }))}
                placeholder="Введите категорию"
                className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            ) : (
              <select
                value={form.category}
                onChange={(e) => setForm((p) => ({ ...p, category: e.target.value }))}
                className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                <option value="">Выберите категорию</option>
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Account */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Счёт</label>
            <select
              value={form.accountId}
              onChange={(e) => setForm((p) => ({ ...p, accountId: e.target.value }))}
              className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
            >
              <option value="">Выберите счёт</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.type === 'cash' ? 'Наличные' : 'Банк'})
                </option>
              ))}
            </select>
          </div>

          {/* Activity */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Вид деятельности</label>
            <div className="flex gap-2">
              {([
                { value: 'operational', label: 'Операционная' },
                { value: 'investment', label: 'Инвестиционная' },
                { value: 'financial', label: 'Финансовая' },
              ] as { value: FinancialActivity; label: string }[]).map((a) => (
                <button
                  key={a.value}
                  type="button"
                  onClick={() => setForm((p) => ({ ...p, activity: a.value }))}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                    form.activity === a.value
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-card border-border text-foreground hover:bg-muted'
                  }`}
                >
                  {a.label}
                </button>
              ))}
            </div>
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Описание <span className="text-muted-foreground font-normal">(необязательно)</span></label>
            <textarea
              value={form.description}
              onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
              rows={2}
              placeholder="Описание операции..."
              className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
            />
          </div>

          {/* Date */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Дата</label>
            <input
              type="date"
              value={form.date}
              onChange={(e) => setForm((p) => ({ ...p, date: e.target.value }))}
              className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
        </div>

        <DialogFooter>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="px-4 py-2 text-sm font-medium text-foreground bg-card border border-border rounded-lg hover:bg-muted transition-colors"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="px-4 py-2 text-sm font-medium text-primary-foreground bg-primary rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:pointer-events-none"
          >
            {saving ? 'Создание...' : 'Создать операцию'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
