'use client'

import { useState, useEffect, useCallback } from 'react'
import { formatCurrency } from '@/lib/helpers'
import { dAdd, dMul, dSum } from '@/lib/decimal'
import { useAuth } from '@/lib/auth-store'
import {
  type FinancialAccount,
  type Ingredient,
  type Supplier,
  type Asset,
  type Liability,
  type EquityEntry,
  type AssetCategory,
  type LiabilityCategory,
  type EquityCategory,
  ASSET_CATEGORY_LABELS,
  LIABILITY_CATEGORY_LABELS,
  EQUITY_CATEGORY_LABELS,
} from '@/lib/types'
import {
  fetchFinancialAccounts,
  fetchIngredients,
  fetchSuppliers,
  fetchAssets,
  fetchLiabilities,
  fetchEquity,
  createAsset,
  updateAsset,
  deleteAsset,
  createLiability,
  updateLiability,
  deleteLiability,
  createEquity,
  updateEquity,
  deleteEquity,
} from '@/lib/queries'
import { toast } from 'sonner'
import { ChevronDown, ChevronRight, Plus, TrendingUp, TrendingDown, Wallet, Scale } from 'lucide-react'
import { ManageAssetDialog } from '@/components/dialogs/manage-asset-dialog'
import { ManageLiabilityDialog } from '@/components/dialogs/manage-liability-dialog'
import { ManageEquityDialog } from '@/components/dialogs/manage-equity-dialog'

// ─── Collapsible Section ─────────────────────────────────────────────────────

function BalanceSection({
  title,
  subtitle,
  total,
  color,
  children,
  onAdd,
  canManage,
  addLabel,
}: {
  title: string
  subtitle?: string
  total: number
  color: 'emerald' | 'red' | 'blue'
  children: React.ReactNode
  onAdd?: () => void
  canManage?: boolean
  addLabel?: string
}) {
  const [expanded, setExpanded] = useState(true)
  const colorClasses = {
    emerald: { header: 'bg-emerald-500/5', total: 'bg-emerald-500/10', text: 'text-emerald-600' },
    red: { header: 'bg-destructive/5', total: 'bg-destructive/10', text: 'text-destructive' },
    blue: { header: 'bg-primary/5', total: 'bg-primary/10', text: 'text-primary' },
  }[color]

  return (
    <div className="bg-card rounded-xl border border-border overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className={`w-full px-5 py-3 border-b border-border flex items-center justify-between ${colorClasses.header}`}
      >
        <div className="text-left">
          <h3 className="text-sm font-bold text-foreground">{title}</h3>
          {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-sm font-bold ${colorClasses.text}`}>{formatCurrency(total)}</span>
          {expanded ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}
        </div>
      </button>
      {expanded && (
        <>
          <div className="divide-y divide-border">{children}</div>
          {canManage && onAdd && (
            <button
              onClick={onAdd}
              className="w-full px-5 py-2.5 text-sm text-primary hover:bg-muted/50 transition-colors flex items-center gap-1.5 border-t border-border"
            >
              <Plus className="size-4" />
              {addLabel ?? '+ Добавить'}
            </button>
          )}
        </>
      )}
    </div>
  )
}

// ─── Subsection (group header) ───────────────────────────────────────────────

function SubsectionHeader({ label, total }: { label: string; total: number }) {
  return (
    <div className="px-5 py-2 bg-muted/30 flex items-center justify-between">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className="text-xs font-semibold text-muted-foreground">{formatCurrency(total)}</p>
    </div>
  )
}

// ─── Row ─────────────────────────────────────────────────────────────────────

function BalanceRow({
  name,
  amount,
  onClick,
  clickable,
}: {
  name: string
  amount: number
  onClick?: () => void
  clickable?: boolean
}) {
  const Comp = clickable ? 'button' : 'div'
  return (
    <Comp
      onClick={onClick}
      className={`flex items-center justify-between px-6 py-2.5 w-full text-left ${clickable ? 'hover:bg-muted/40 cursor-pointer transition-colors' : ''}`}
    >
      <span className="text-sm text-foreground">{name}</span>
      <span className="text-sm font-medium text-foreground">{formatCurrency(amount)}</span>
    </Comp>
  )
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function BalancePage() {
  const { canDo } = useAuth()
  const canManage = canDo('finance.manage')

  const [accounts, setAccounts] = useState<FinancialAccount[]>([])
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [assets, setAssets] = useState<Asset[]>([])
  const [liabilities, setLiabilities] = useState<Liability[]>([])
  const [equity, setEquity] = useState<EquityEntry[]>([])
  const [loading, setLoading] = useState(true)

  // Dialog state
  const [assetDialogOpen, setAssetDialogOpen] = useState(false)
  const [editingAsset, setEditingAsset] = useState<Asset | undefined>()
  const [liabilityDialogOpen, setLiabilityDialogOpen] = useState(false)
  const [editingLiability, setEditingLiability] = useState<Liability | undefined>()
  const [equityDialogOpen, setEquityDialogOpen] = useState(false)
  const [editingEquity, setEditingEquity] = useState<EquityEntry | undefined>()

  const loadData = useCallback(async () => {
    try {
      const [a, i, s, as_, l, e] = await Promise.all([
        fetchFinancialAccounts(),
        fetchIngredients(),
        fetchSuppliers(),
        fetchAssets(),
        fetchLiabilities(),
        fetchEquity(),
      ])
      setAccounts(a)
      setIngredients(i)
      setSuppliers(s)
      setAssets(as_)
      setLiabilities(l)
      setEquity(e)
    } catch {
      toast.error('Ошибка загрузки данных')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadData() }, [loadData])

  // ─── CRUD handlers ────────────────────────────────────────────────────────

  async function handleAssetSubmit(data: Omit<Asset, 'id'>) {
    try {
      if (editingAsset) {
        await updateAsset(editingAsset.id, data)
        toast.success('Актив обновлён')
      } else {
        await createAsset(data)
        toast.success('Актив добавлен')
      }
      await loadData()
    } catch { toast.error('Ошибка сохранения') }
  }

  async function handleAssetDelete(id: string) {
    try {
      await deleteAsset(id)
      toast.success('Актив удалён')
      await loadData()
    } catch { toast.error('Ошибка удаления') }
  }

  async function handleLiabilitySubmit(data: Omit<Liability, 'id' | 'remainingAmount'>) {
    try {
      if (editingLiability) {
        await updateLiability(editingLiability.id, data)
        toast.success('Обязательство обновлено')
      } else {
        await createLiability(data)
        toast.success('Обязательство добавлено')
      }
      await loadData()
    } catch { toast.error('Ошибка сохранения') }
  }

  async function handleLiabilityDelete(id: string) {
    try {
      await deleteLiability(id)
      toast.success('Обязательство удалено')
      await loadData()
    } catch { toast.error('Ошибка удаления') }
  }

  async function handleEquitySubmit(data: Omit<EquityEntry, 'id'>) {
    try {
      if (editingEquity) {
        await updateEquity(editingEquity.id, data)
        toast.success('Запись обновлена')
      } else {
        await createEquity(data)
        toast.success('Запись добавлена')
      }
      await loadData()
    } catch { toast.error('Ошибка сохранения') }
  }

  async function handleEquityDelete(id: string) {
    try {
      await deleteEquity(id)
      toast.success('Запись удалена')
      await loadData()
    } catch { toast.error('Ошибка удаления') }
  }

  // ─── Loading ──────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-64">
        <div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    )
  }

  // ─── Calculations ─────────────────────────────────────────────────────────

  // Current assets (auto)
  const totalCash = dSum(accounts.map(a => a.balance))
  const inventoryValue = dSum(ingredients.map(i => dMul(i.qty, i.pricePerUnit)))
  const totalCurrentAssets = dAdd(totalCash, inventoryValue)

  // Non-current assets (manual) grouped by category
  const assetsByCategory = new Map<AssetCategory, Asset[]>()
  for (const a of assets) {
    const list = assetsByCategory.get(a.category) ?? []
    list.push(a)
    assetsByCategory.set(a.category, list)
  }
  const totalNonCurrentAssets = assets.reduce((s, a) => s + a.amount, 0)

  const totalAssets = totalCurrentAssets + totalNonCurrentAssets

  // Liabilities — supplier debts (auto)
  const supplierDebts = suppliers.filter((s) => s.currentDebt > 0)
  const totalSupplierDebt = supplierDebts.reduce((s, sup) => s + sup.currentDebt, 0)

  // Liabilities — manual
  const liabilitiesByCategory = new Map<LiabilityCategory, Liability[]>()
  for (const l of liabilities) {
    const list = liabilitiesByCategory.get(l.category) ?? []
    list.push(l)
    liabilitiesByCategory.set(l.category, list)
  }
  const totalManualLiabilities = liabilities.reduce((s, l) => s + l.remainingAmount, 0)
  const totalLiabilities = totalSupplierDebt + totalManualLiabilities

  // Equity (manual)
  const equityByCategory = new Map<EquityCategory, EquityEntry[]>()
  for (const e of equity) {
    const list = equityByCategory.get(e.category) ?? []
    list.push(e)
    equityByCategory.set(e.category, list)
  }
  const totalEquity = equity.reduce((s, e) => s + e.amount, 0)

  const totalPassive = totalLiabilities + totalEquity
  const difference = totalAssets - totalPassive
  const isBalanced = Math.abs(difference) < 1

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5">
      <div>
        <h1 className="text-xl font-bold text-foreground">Баланс</h1>
        <p className="text-muted-foreground text-sm mt-0.5">Бухгалтерский баланс ресторана</p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {[
          { label: 'Итого активы', value: formatCurrency(totalAssets), icon: TrendingUp, color: 'text-emerald-600', bg: 'bg-emerald-100' },
          { label: 'Обязательства', value: formatCurrency(totalLiabilities), icon: TrendingDown, color: 'text-destructive', bg: 'bg-red-100' },
          { label: 'Собственный капитал', value: formatCurrency(totalEquity), icon: Wallet, color: 'text-primary', bg: 'bg-primary/10' },
          { label: 'Баланс', value: isBalanced ? 'Сходится' : `Разница: ${formatCurrency(Math.abs(difference))}`, icon: Scale, color: isBalanced ? 'text-emerald-600' : 'text-amber-600', bg: isBalanced ? 'bg-emerald-100' : 'bg-amber-100' },
        ].map((item) => (
          <div key={item.label} className="bg-card rounded-xl border border-border p-4 flex items-center gap-3">
            <div className={`size-10 rounded-lg flex items-center justify-center shrink-0 ${item.bg}`}>
              <item.icon className={`size-5 ${item.color}`} />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{item.label}</p>
              <p className={`text-base font-bold ${item.color}`}>{item.value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Balance Sheet */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* ═══ AKTИBЫ ═══ */}
        <div className="space-y-4">
          <h2 className="text-sm font-bold text-foreground uppercase tracking-wider">Активы</h2>

          {/* Current Assets (auto) */}
          <BalanceSection
            title="Оборотные активы"
            subtitle="Рассчитываются автоматически"
            total={totalCurrentAssets}
            color="emerald"
          >
            <SubsectionHeader label="Денежные средства" total={totalCash} />
            {accounts.map((a) => (
              <BalanceRow key={a.id} name={a.name} amount={a.balance} />
            ))}
            <SubsectionHeader label="Запасы (склад)" total={inventoryValue} />
            <BalanceRow name="Остатки ингредиентов" amount={inventoryValue} />
          </BalanceSection>

          {/* Non-current Assets (manual) */}
          <BalanceSection
            title="Внеоборотные активы"
            subtitle="Ручной учёт"
            total={totalNonCurrentAssets}
            color="emerald"
            canManage={canManage}
            onAdd={() => { setEditingAsset(undefined); setAssetDialogOpen(true) }}
            addLabel="Добавить актив"
          >
            {Array.from(assetsByCategory.entries()).map(([cat, items]) => (
              <div key={cat}>
                <SubsectionHeader label={ASSET_CATEGORY_LABELS[cat]} total={items.reduce((s, a) => s + a.amount, 0)} />
                {items.map((a) => (
                  <BalanceRow
                    key={a.id}
                    name={a.name}
                    amount={a.amount}
                    clickable={canManage}
                    onClick={canManage ? () => { setEditingAsset(a); setAssetDialogOpen(true) } : undefined}
                  />
                ))}
              </div>
            ))}
            {assets.length === 0 && (
              <div className="px-6 py-4 text-sm text-muted-foreground text-center">Нет записей</div>
            )}
          </BalanceSection>

          {/* Total Assets */}
          <div className="bg-emerald-500/10 rounded-xl border border-emerald-500/20 p-4 flex items-center justify-between">
            <span className="text-sm font-bold text-foreground">ИТОГО АКТИВЫ</span>
            <span className="text-lg font-bold text-emerald-600">{formatCurrency(totalAssets)}</span>
          </div>
        </div>

        {/* ═══ ПАССИВЫ ═══ */}
        <div className="space-y-4">
          <h2 className="text-sm font-bold text-foreground uppercase tracking-wider">Пассивы</h2>

          {/* Liabilities — Supplier Debts (auto) */}
          <BalanceSection
            title="Обязательства"
            subtitle="Долги и кредиты"
            total={totalLiabilities}
            color="red"
          >
            <SubsectionHeader label="Долги поставщикам (авто)" total={totalSupplierDebt} />
            {supplierDebts.length > 0 ? (
              supplierDebts.map((s) => (
                <BalanceRow key={s.id} name={s.name} amount={s.currentDebt} />
              ))
            ) : (
              <div className="px-6 py-2.5 text-sm text-muted-foreground">Нет долгов</div>
            )}

            {/* Manual liabilities */}
            {Array.from(liabilitiesByCategory.entries()).map(([cat, items]) => (
              <div key={cat}>
                <SubsectionHeader label={LIABILITY_CATEGORY_LABELS[cat]} total={items.reduce((s, l) => s + l.remainingAmount, 0)} />
                {items.map((l) => (
                  <BalanceRow
                    key={l.id}
                    name={l.name}
                    amount={l.remainingAmount}
                    clickable={canManage}
                    onClick={canManage ? () => { setEditingLiability(l); setLiabilityDialogOpen(true) } : undefined}
                  />
                ))}
              </div>
            ))}
            {liabilities.length === 0 && supplierDebts.length === 0 && (
              <div className="px-6 py-4 text-sm text-muted-foreground text-center">Нет обязательств</div>
            )}
          </BalanceSection>

          {canManage && (
            <button
              onClick={() => { setEditingLiability(undefined); setLiabilityDialogOpen(true) }}
              className="w-full px-5 py-2.5 text-sm text-primary hover:bg-muted/50 transition-colors flex items-center justify-center gap-1.5 rounded-xl border border-dashed border-border bg-card"
            >
              <Plus className="size-4" />
              Добавить обязательство
            </button>
          )}

          {/* Equity (manual) */}
          <BalanceSection
            title="Собственный капитал"
            subtitle="Ручной учёт"
            total={totalEquity}
            color="blue"
            canManage={canManage}
            onAdd={() => { setEditingEquity(undefined); setEquityDialogOpen(true) }}
            addLabel="Добавить капитал"
          >
            {Array.from(equityByCategory.entries()).map(([cat, items]) => (
              <div key={cat}>
                <SubsectionHeader label={EQUITY_CATEGORY_LABELS[cat]} total={items.reduce((s, e) => s + e.amount, 0)} />
                {items.map((e) => (
                  <BalanceRow
                    key={e.id}
                    name={e.name}
                    amount={e.amount}
                    clickable={canManage}
                    onClick={canManage ? () => { setEditingEquity(e); setEquityDialogOpen(true) } : undefined}
                  />
                ))}
              </div>
            ))}
            {equity.length === 0 && (
              <div className="px-6 py-4 text-sm text-muted-foreground text-center">Нет записей</div>
            )}
          </BalanceSection>

          {/* Total Passive */}
          <div className="bg-destructive/10 rounded-xl border border-destructive/20 p-4 flex items-center justify-between">
            <span className="text-sm font-bold text-foreground">ИТОГО ПАССИВЫ</span>
            <span className="text-lg font-bold text-destructive">{formatCurrency(totalPassive)}</span>
          </div>
        </div>
      </div>

      {/* Balance check */}
      <div className={`rounded-xl border p-4 flex items-center justify-between ${
        isBalanced
          ? 'bg-emerald-500/10 border-emerald-500/20'
          : 'bg-amber-500/10 border-amber-500/20'
      }`}>
        <div>
          <p className="text-sm font-bold text-foreground">Проверка баланса</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Активы ({formatCurrency(totalAssets)}) = Обязательства ({formatCurrency(totalLiabilities)}) + Капитал ({formatCurrency(totalEquity)})
          </p>
        </div>
        {isBalanced ? (
          <span className="text-sm font-bold text-emerald-600">Баланс сходится</span>
        ) : (
          <span className="text-sm font-bold text-amber-600">Разница: {formatCurrency(Math.abs(difference))}</span>
        )}
      </div>

      {/* Dialogs */}
      <ManageAssetDialog
        open={assetDialogOpen}
        onOpenChange={setAssetDialogOpen}
        asset={editingAsset}
        onSubmit={handleAssetSubmit}
        onDelete={handleAssetDelete}
      />
      <ManageLiabilityDialog
        open={liabilityDialogOpen}
        onOpenChange={setLiabilityDialogOpen}
        liability={editingLiability}
        onSubmit={handleLiabilitySubmit}
        onDelete={handleLiabilityDelete}
      />
      <ManageEquityDialog
        open={equityDialogOpen}
        onOpenChange={setEquityDialogOpen}
        entry={editingEquity}
        onSubmit={handleEquitySubmit}
        onDelete={handleEquityDelete}
      />
    </div>
  )
}
