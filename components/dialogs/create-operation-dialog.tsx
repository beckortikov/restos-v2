'use client'

import { useState, useEffect, useMemo } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from '@/components/ui/command'
import {
  type FinancialActivity,
  type FinancialOperationType,
  type FinancialAccount,
  type FinancialOperation,
} from '@/lib/types'
import { fetchFinancialAccounts, fetchCustomCategories, createCustomCategory, deleteCustomCategory } from '@/lib/queries'
import { selectableAccounts } from '@/lib/queries/finance'
import { DecimalInput } from '@/components/ui/decimal-input'
import { ChevronsUpDown, Check, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

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
  // affectsShift — только для расхода, опт-ин: наличные физически выданы из
  // ящика текущей открытой смены → помимо счёта уменьшить и «Ожидается касса».
  // По умолчанию выключено: счёт «Наличные» один на ресторан, ящик кассира
  // двигают только сменные операции. В режиме редактирования не показывается
  // и не отправляется — бэк сам сохраняет сменную природу записи.
  affectsShift: boolean
}

interface CreateOperationDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (operation: OperationForm) => void
  // initialOperation — задан → диалог в режиме редактирования (владелец правит
  // уже созданную операцию задним числом): заголовок/кнопка меняются, форма
  // преднаполняется. Сам onSubmit не меняется — какой запрос слать (create/
  // update) решает вызывающая страница, у неё уже есть editingOperation.
  initialOperation?: FinancialOperation | null
}

export function CreateOperationDialog({ open, onOpenChange, onSubmit, initialOperation }: CreateOperationDialogProps) {
  const today = new Date().toISOString().split('T')[0]
  const isEdit = !!initialOperation
  const [form, setForm] = useState<OperationForm>({
    type: 'out',
    amount: 0,
    category: '',
    accountId: '',
    activity: 'operational',
    description: '',
    date: today,
    affectsShift: false,
  })
  const [accounts, setAccounts] = useState<FinancialAccount[]>([])
  const [dbCategories, setDbCategories] = useState<{ id: string; name: string; type: string }[]>([])
  const [dataLoaded, setDataLoaded] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      // Always re-fetch accounts when dialog opens (accounts may have been added)
      fetchFinancialAccounts().then(selectableAccounts)
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
      setForm(initialOperation ? {
        type: initialOperation.type,
        amount: initialOperation.amount,
        category: initialOperation.category,
        accountId: initialOperation.accountId,
        activity: initialOperation.activity,
        description: initialOperation.description ?? '',
        date: initialOperation.date || today,
        affectsShift: false,
      } : {
        type: 'out', amount: 0, category: '', accountId: '',
        activity: 'operational', description: '', date: today,
        affectsShift: false,
      })
      setSaving(false)
    }
  }, [open, initialOperation])

  const builtInCategories = form.type === 'in' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES
  const customCategoriesForType = useMemo(
    () => dbCategories.filter(c => c.type === form.type && !builtInCategories.includes(c.name)),
    [dbCategories, form.type, builtInCategories],
  )

  async function handleSubmit() {
    setSaving(true)
    // Введённую вручную категорию (нет ни в базовом списке, ни в кастомных)
    // сохраняем — попадёт в подсказки в след. раз.
    const typed = form.category.trim()
    if (typed) {
      const known = builtInCategories.includes(typed) || dbCategories.some(c => c.type === form.type && c.name === typed)
      if (!known) {
        try {
          const created = await createCustomCategory(typed, form.type as 'in' | 'out')
          setDbCategories(prev => [...prev, created])
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

  async function handleDeleteCustomCategory(id: string, name: string) {
    if (!confirm(`Удалить категорию «${name}»?\n\nУже созданные операции с этой категорией не изменятся — пропадёт только из списка выбора.`)) return
    try {
      await deleteCustomCategory(id)
      setDbCategories(prev => prev.filter(c => c.id !== id))
      if (form.category === name) setForm(p => ({ ...p, category: '' }))
      toast.success('Категория удалена')
    } catch {
      toast.error('Не удалось удалить категорию')
    }
  }

  const canSubmit = form.amount > 0 && form.category && form.accountId && !saving

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* max-h + flex-col: заголовок/футер закреплены, прокручивается только
          список полей — иначе на длинной форме кнопка «Создать» уезжала за
          пределы экрана и требовала скролла всего диалога целиком. */}
      <DialogContent className="sm:max-w-lg max-h-[90vh] flex flex-col rounded-xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>{isEdit ? 'Редактировать операцию' : 'Новая операция'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 overflow-y-auto flex-1 min-h-0">
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

          {/* Category — поиск по встроенным + своим категориям, можно вписать новую. */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Категория</label>
            <CategoryCombobox
              value={form.category}
              onChange={(v) => setForm((p) => ({ ...p, category: v }))}
              builtIn={builtInCategories}
              custom={customCategoriesForType}
              onDeleteCustom={handleDeleteCustomCategory}
            />
            {/* Н9: кассовая закупка не приходует склад — для складского учёта нужна накладная. */}
            {form.type === 'out' && (form.category === 'Закупка продуктов' || form.category === 'Закупка хозтоваров') && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Это расход из кассы — склад не пополнится. Чтобы товар встал на остаток, оформите приёмку (накладную).
              </p>
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

          {/* Выдано из кассы смены — опт-ин только для нового расхода: по
              умолчанию проводка двигает лишь счёт, ящик открытой смены — нет
              (сменные выдачи оформляются расходом со смены). В редактировании
              не показываем: сменную природу записи сохраняет бэк. */}
          {form.type === 'out' && !isEdit && (
            <label className="flex items-start gap-2.5 rounded-lg border border-border bg-card px-3 py-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={form.affectsShift}
                onChange={(e) => setForm((p) => ({ ...p, affectsShift: e.target.checked }))}
                className="mt-0.5 size-4 rounded border-border accent-primary"
              />
              <span>
                <span className="block text-sm font-medium text-foreground">Наличные выданы из кассы смены</span>
                <span className="block text-xs text-muted-foreground mt-0.5">
                  Дополнительно уменьшит «Ожидается касса» открытой смены. Включайте, только если деньги физически взяты из ящика кассира.
                </span>
              </span>
            </label>
          )}

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

        <DialogFooter className="shrink-0">
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
            {isEdit ? (saving ? 'Сохранение...' : 'Сохранить') : (saving ? 'Создание...' : 'Создать операцию')}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── CategoryCombobox ────────────────────────────────────────────────────────
// Категория операции — поиск по встроенному набору + своим категориям
// (сохранённым через createCustomCategory), с возможностью вписать новую
// («нет свободной название категорий которую можно ввести владельцу» — она
// была: нативный <input list=datalist>, просто не выглядела и не искалась
// как настоящий выбор. Тот же паттерн, что PositionCombobox в
// settings/users/page.tsx.) Свои категории — с крестиком удаления по ховеру,
// встроенные — нет (это не то, чем владелец управляет).
function CategoryCombobox({ value, onChange, builtIn, custom, onDeleteCustom }: {
  value: string
  onChange: (v: string) => void
  builtIn: string[]
  custom: { id: string; name: string }[]
  onDeleteCustom: (id: string, name: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const all = useMemo(() => [...builtIn, ...custom.map((c) => c.name)], [builtIn, custom])
  const filtered = q ? all.filter((s) => s.toLowerCase().includes(q)) : all
  const hasExactMatch = all.some((s) => s.toLowerCase() === q)
  const customById = useMemo(() => new Map(custom.map((c) => [c.name, c.id])), [custom])

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); setQuery(o ? value : '') }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg text-left flex items-center justify-between gap-2 hover:bg-muted/40 transition-colors focus:outline-none focus:ring-2 focus:ring-primary/30"
        >
          <span className={`truncate ${value ? 'text-foreground' : 'text-muted-foreground'}`}>{value || 'Введите или выберите категорию'}</span>
          <ChevronsUpDown className="size-3.5 text-muted-foreground shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="p-0 w-[var(--radix-popover-trigger-width)]">
        <Command shouldFilter={false}>
          <CommandInput value={query} onValueChange={setQuery} placeholder="Найти категорию..." />
          <CommandList>
            <CommandEmpty>Не найдено</CommandEmpty>
            <CommandGroup>
              {filtered.map((s) => {
                const customId = customById.get(s)
                return (
                  <CommandItem key={s} value={s} onSelect={() => { onChange(s); setOpen(false) }} className="group">
                    <Check className={`mr-2 size-4 shrink-0 ${value === s ? 'opacity-100' : 'opacity-0'}`} />
                    <span className="flex-1 truncate">{s}</span>
                    {customId && (
                      <button
                        type="button"
                        title="Удалить категорию"
                        onClick={(e) => { e.stopPropagation(); onDeleteCustom(customId, s) }}
                        className="opacity-0 group-hover:opacity-100 p-1 -m-1 rounded shrink-0 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-opacity"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    )}
                  </CommandItem>
                )
              })}
            </CommandGroup>
            {query.trim() && !hasExactMatch && (
              <CommandGroup>
                <CommandItem value={`__create__${query.trim()}`} onSelect={() => { onChange(query.trim()); setOpen(false) }}>
                  <Plus className="mr-2 size-4" />
                  Добавить «{query.trim()}»
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
