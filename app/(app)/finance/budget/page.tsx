'use client'

import { lazy, Suspense } from 'react'
import { useState, useEffect, useCallback } from 'react'
import { formatCurrency } from '@/lib/helpers'
import { type BudgetLine } from '@/lib/types'
import { fetchBudgetLines, createBudgetLine, updateBudgetLine, deleteBudgetLine } from '@/lib/queries'
import { DatePeriodFilter, type PeriodKey } from '@/components/date-period-filter'
import { useAuth } from '@/lib/auth-store'
import { toast } from 'sonner'
import { Plus, Pencil, Trash2, Check, X } from 'lucide-react'

const BudgetChart = lazy(() => import('@/components/charts/budget-chart'))

function ProgressBar({ plan, fact }: { plan: number; fact: number }) {
  const pct = plan > 0 ? Math.min(130, (fact / plan) * 100) : 0
  const over = pct > 100
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${over ? 'bg-destructive' : 'bg-primary'}`}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
      <span className={`text-xs font-medium w-10 text-right ${over ? 'text-destructive' : pct >= 90 ? 'text-emerald-600' : 'text-amber-600'}`}>
        {pct.toFixed(0)}%
      </span>
    </div>
  )
}

// ─── Add new line form ────────────────────────────────────────────────────────

function AddLineForm({ onSave, onCancel }: { onSave: (data: { category: string; type: 'in' | 'out'; plan_amount: number; fact_amount: number; period: string }) => void; onCancel: () => void }) {
  const [category, setCategory] = useState('')
  const [type, setType] = useState<'in' | 'out'>('out')
  const [plan, setPlan] = useState('')
  const [fact, setFact] = useState('')
  const [period, setPeriod] = useState(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!category.trim()) { toast.error('Введите категорию'); return }
    onSave({ category: category.trim(), type, plan_amount: Number(plan) || 0, fact_amount: Number(fact) || 0, period })
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3 p-4 bg-muted/30 rounded-lg border border-border">
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-muted-foreground">Категория</label>
        <input value={category} onChange={e => setCategory(e.target.value)} placeholder="Название статьи" className="h-9 px-3 rounded-md border border-border bg-background text-sm w-48 focus:outline-none focus:ring-2 focus:ring-primary/30" />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-muted-foreground">Тип</label>
        <select value={type} onChange={e => setType(e.target.value as 'in' | 'out')} className="h-9 px-3 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30">
          <option value="in">Доход</option>
          <option value="out">Расход</option>
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-muted-foreground">План</label>
        <input type="number" value={plan} onChange={e => setPlan(e.target.value)} placeholder="0" className="h-9 px-3 rounded-md border border-border bg-background text-sm w-28 focus:outline-none focus:ring-2 focus:ring-primary/30" />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-muted-foreground">Факт</label>
        <input type="number" value={fact} onChange={e => setFact(e.target.value)} placeholder="0" className="h-9 px-3 rounded-md border border-border bg-background text-sm w-28 focus:outline-none focus:ring-2 focus:ring-primary/30" />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-muted-foreground">Период</label>
        <input type="month" value={period} onChange={e => setPeriod(e.target.value)} className="h-9 px-3 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
      </div>
      <div className="flex gap-2">
        <button type="submit" className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors">Добавить</button>
        <button type="button" onClick={onCancel} className="h-9 px-3 rounded-md border border-border text-sm hover:bg-muted transition-colors"><X className="size-4" /></button>
      </div>
    </form>
  )
}

// ─── Editable row ─────────────────────────────────────────────────────────────

function EditableRow({ line, onSave, onCancel }: { line: BudgetLine; onSave: (id: string, data: { category: string; plan_amount: number; fact_amount: number }) => void; onCancel: () => void }) {
  const [category, setCategory] = useState(line.category)
  const [plan, setPlan] = useState(String(line.planAmount))
  const [fact, setFact] = useState(String(line.factAmount))

  return (
    <tr className="border-b border-border bg-primary/5">
      <td className="px-4 py-2">
        <input value={category} onChange={e => setCategory(e.target.value)} className="h-8 px-2 rounded border border-border bg-background text-sm w-full focus:outline-none focus:ring-2 focus:ring-primary/30" />
      </td>
      <td className="px-4 py-2">
        <input type="number" value={plan} onChange={e => setPlan(e.target.value)} className="h-8 px-2 rounded border border-border bg-background text-sm w-24 focus:outline-none focus:ring-2 focus:ring-primary/30" />
      </td>
      <td className="px-4 py-2">
        <input type="number" value={fact} onChange={e => setFact(e.target.value)} className="h-8 px-2 rounded border border-border bg-background text-sm w-24 focus:outline-none focus:ring-2 focus:ring-primary/30" />
      </td>
      <td className="px-4 py-2">
        <div className="flex gap-1">
          <button onClick={() => onSave(line.id, { category: category.trim(), plan_amount: Number(plan) || 0, fact_amount: Number(fact) || 0 })} className="p-1.5 rounded hover:bg-emerald-100 text-emerald-600 transition-colors" title="Сохранить"><Check className="size-4" /></button>
          <button onClick={onCancel} className="p-1.5 rounded hover:bg-muted text-muted-foreground transition-colors" title="Отмена"><X className="size-4" /></button>
        </div>
      </td>
    </tr>
  )
}

// ─── Budget table ─────────────────────────────────────────────────────────────

function BudgetTable({ title, lines, bgClass, canEdit, editingId, onEdit, onSaveEdit, onCancelEdit, onDelete }: {
  title: string
  lines: BudgetLine[]
  bgClass: string
  canEdit: boolean
  editingId: string | null
  onEdit: (id: string) => void
  onSaveEdit: (id: string, data: { category: string; plan_amount: number; fact_amount: number }) => void
  onCancelEdit: () => void
  onDelete: (id: string) => void
}) {
  return (
    <div className="bg-card rounded-xl border border-border overflow-hidden">
      <div className={`px-5 py-3 border-b border-border ${bgClass}`}>
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[600px]">
          <thead>
            <tr className="border-b border-border bg-muted/30">
              {['Статья', 'План', 'Факт', canEdit ? 'Действия' : 'Исп.'].map((h) => (
                <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {lines.map((b) =>
              editingId === b.id ? (
                <EditableRow key={b.id} line={b} onSave={onSaveEdit} onCancel={onCancelEdit} />
              ) : (
                <tr key={b.id} className="border-b border-border last:border-0 hover:bg-muted/20 group">
                  <td className="px-4 py-3 text-sm text-foreground">{b.category}</td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">{formatCurrency(b.planAmount)}</td>
                  <td className="px-4 py-3 text-sm font-medium text-foreground">{formatCurrency(b.factAmount)}</td>
                  <td className="px-4 py-3 w-36">
                    {canEdit ? (
                      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onClick={() => onEdit(b.id)} className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors" title="Редактировать"><Pencil className="size-3.5" /></button>
                        <button onClick={() => onDelete(b.id)} className="p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors" title="Удалить"><Trash2 className="size-3.5" /></button>
                      </div>
                    ) : (
                      <ProgressBar plan={b.planAmount} fact={b.factAmount} />
                    )}
                  </td>
                </tr>
              )
            )}
            {lines.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-8 text-center text-sm text-muted-foreground">Нет данных</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function BudgetPage() {
  const { canDo } = useAuth()
  const canEdit = canDo('finance.manage')

  const [budgetLines, setBudgetLines] = useState<BudgetLine[]>([])
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState<PeriodKey>('all')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [showAddForm, setShowAddForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  const loadData = useCallback(() => {
    setLoading(true)
    fetchBudgetLines()
      .then(setBudgetLines)
      .catch(() => toast.error('Ошибка загрузки бюджета'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { loadData() }, [loadData])

  // ─── Handlers ───────────────────────────────────────────────────────────────

  async function handleCreate(data: { category: string; type: 'in' | 'out'; plan_amount: number; fact_amount: number; period: string }) {
    try {
      await createBudgetLine(data)
      toast.success('Строка добавлена')
      setShowAddForm(false)
      loadData()
    } catch {
      toast.error('Ошибка при добавлении')
    }
  }

  async function handleUpdate(id: string, data: { category: string; plan_amount: number; fact_amount: number }) {
    try {
      await updateBudgetLine(id, data)
      toast.success('Строка обновлена')
      setEditingId(null)
      loadData()
    } catch {
      toast.error('Ошибка при обновлении')
    }
  }

  async function handleDelete(id: string) {
    setDeleting(id)
  }

  async function confirmDelete() {
    if (!deleting) return
    try {
      await deleteBudgetLine(deleting)
      toast.success('Строка удалена')
      loadData()
    } catch {
      toast.error('Ошибка при удалении')
    } finally {
      setDeleting(null)
    }
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

  if (loading) return <div className="p-6 flex items-center justify-center h-64"><div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>

  const incomeLines = budgetLines.filter((b) => b.type === 'in')
  const expenseLines = budgetLines.filter((b) => b.type === 'out')

  const totalPlanIncome = incomeLines.reduce((s, b) => s + b.planAmount, 0)
  const totalFactIncome = incomeLines.reduce((s, b) => s + b.factAmount, 0)
  const totalPlanExpense = expenseLines.reduce((s, b) => s + b.planAmount, 0)
  const totalFactExpense = expenseLines.reduce((s, b) => s + b.factAmount, 0)

  const planProfit = totalPlanIncome - totalPlanExpense
  const factProfit = totalFactIncome - totalFactExpense

  const chartData = expenseLines.map((b) => ({
    name: b.category.length > 20 ? b.category.slice(0, 18) + '...' : b.category,
    План: b.planAmount,
    Факт: b.factAmount,
  }))

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">Бюджет</h1>
          <p className="text-muted-foreground text-sm mt-0.5">План / Факт</p>
        </div>
        <div className="flex items-center gap-3">
          {canEdit && (
            <button
              onClick={() => { setShowAddForm(!showAddForm); setEditingId(null) }}
              className="inline-flex items-center gap-2 h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
            >
              <Plus className="size-4" />
              Добавить строку
            </button>
          )}
          <DatePeriodFilter period={period} onPeriodChange={setPeriod} customFrom={customFrom} customTo={customTo} onCustomFromChange={setCustomFrom} onCustomToChange={setCustomTo} />
        </div>
      </div>

      {/* Add form */}
      {showAddForm && canEdit && (
        <AddLineForm onSave={handleCreate} onCancel={() => setShowAddForm(false)} />
      )}

      {/* KPI */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {[
          { label: 'Доходы (план)', value: formatCurrency(totalPlanIncome), sub: `Факт: ${formatCurrency(totalFactIncome)}`, color: 'text-emerald-600' },
          { label: 'Расходы (план)', value: formatCurrency(totalPlanExpense), sub: `Факт: ${formatCurrency(totalFactExpense)}`, color: 'text-destructive' },
          { label: 'Прибыль (план)', value: formatCurrency(planProfit), sub: `Факт: ${formatCurrency(factProfit)}`, color: 'text-primary' },
          { label: 'Исполнение бюджета', value: `${totalPlanIncome > 0 ? ((totalFactIncome / totalPlanIncome) * 100).toFixed(1) : 0}%`, sub: 'По доходам', color: 'text-blue-600' },
        ].map((item) => (
          <div key={item.label} className="bg-card rounded-xl border border-border p-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">{item.label}</p>
            <p className={`text-xl font-bold mt-1 ${item.color}`}>{item.value}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{item.sub}</p>
          </div>
        ))}
      </div>

      {/* Chart */}
      <div className="bg-card rounded-xl border border-border p-5">
        <h2 className="text-sm font-semibold text-foreground mb-4">Расходы: план vs факт</h2>
        <BudgetChart data={chartData} />
      </div>

      {/* Tables */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <BudgetTable
          title="Доходы"
          lines={incomeLines}
          bgClass="bg-emerald-500/5"
          canEdit={canEdit}
          editingId={editingId}
          onEdit={setEditingId}
          onSaveEdit={handleUpdate}
          onCancelEdit={() => setEditingId(null)}
          onDelete={handleDelete}
        />
        <BudgetTable
          title="Расходы"
          lines={expenseLines}
          bgClass="bg-destructive/5"
          canEdit={canEdit}
          editingId={editingId}
          onEdit={setEditingId}
          onSaveEdit={handleUpdate}
          onCancelEdit={() => setEditingId(null)}
          onDelete={handleDelete}
        />
      </div>

      {/* Delete confirmation */}
      {deleting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-card rounded-xl border border-border p-6 shadow-xl max-w-sm w-full mx-4 space-y-4">
            <h3 className="text-base font-semibold text-foreground">Удалить строку?</h3>
            <p className="text-sm text-muted-foreground">Это действие нельзя отменить. Строка бюджета будет удалена навсегда.</p>
            <div className="flex justify-end gap-3">
              <button onClick={() => setDeleting(null)} className="h-9 px-4 rounded-md border border-border text-sm font-medium hover:bg-muted transition-colors">Отмена</button>
              <button onClick={confirmDelete} className="h-9 px-4 rounded-md bg-destructive text-destructive-foreground text-sm font-medium hover:bg-destructive/90 transition-colors">Удалить</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
