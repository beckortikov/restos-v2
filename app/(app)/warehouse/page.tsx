'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { fetchIngredients, fetchSuppliers } from '@/lib/queries'
import { formatCurrency, formatNum } from '@/lib/helpers'
import type { Ingredient, Supplier } from '@/lib/types'
import {
  Plus, Minus, ClipboardCheck, TriangleAlert, ArrowRight,
  PackageSearch, Boxes, Wallet, ChevronRight,
} from 'lucide-react'

// Складская «главная» (редизайн, Фаза 2). Собирает сводку из существующих
// данных (остатки + поставщики) и даёт быстрые действия — вместо того чтобы
// заставлять кладовщика угадывать, в какой из экранов лезть. Паттерны — из
// приложения закупщика; токены — приложения (bg-card/border-border/text-*).

// ─── Быстрые действия ────────────────────────────────────────────────────
const QUICK = [
  { to: '/warehouse/receipts/new', label: 'Приёмка', icon: Plus, primary: true },
  { to: '/warehouse/writeoffs/new', label: 'Списать', icon: Minus, primary: false },
  { to: '/warehouse/inventory-check', label: 'Инвентаризация', icon: ClipboardCheck, primary: false },
]

export default function WarehouseOverviewPage() {
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const [ings, sups] = await Promise.all([fetchIngredients(), fetchSuppliers()])
      setIngredients(ings)
      setSuppliers(sups)
    } catch {
      /* сеть — оставляем прошлые данные */
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const kpi = useMemo(() => {
    let value = 0
    let low = 0
    let out = 0
    for (const i of ingredients) {
      if (i.qty > 0) value += i.qty * i.pricePerUnit
      if (i.qty <= 0) out++
      else if (i.minQty > 0 && i.qty <= i.minQty) low++
    }
    const debt = suppliers.reduce((s, x) => s + (x.currentDebt > 0 ? x.currentDebt : 0), 0)
    const debtors = suppliers.filter(s => s.currentDebt > 0).length
    return { value, low, out, debt, debtors }
  }, [ingredients, suppliers])

  // Что закупить: позиции с заданной нормой ниже неё, самые «глубокие» сверху.
  const toBuy = useMemo(() =>
    ingredients
      .filter(i => i.minQty > 0 && i.qty < i.minQty)
      .map(i => ({ ...i, shortfall: i.minQty - i.qty }))
      .sort((a, b) => (b.shortfall / (b.minQty || 1)) - (a.shortfall / (a.minQty || 1)))
      .slice(0, 6),
    [ingredients])

  const debtors = useMemo(() =>
    suppliers.filter(s => s.currentDebt > 0).sort((a, b) => b.currentDebt - a.currentDebt).slice(0, 5),
    [suppliers])

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-64">
        <div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-5xl mx-auto">
      <div>
        <h1 className="text-xl font-bold text-foreground">Склад</h1>
        <p className="text-muted-foreground text-sm mt-0.5">Обзор · {formatNum(ingredients.length, 0)} позиций</p>
      </div>

      {/* ── KPI ── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="bg-card rounded-xl border border-border p-4 flex items-center gap-3">
          <div className="size-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <Boxes className="size-5" />
          </div>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Стоимость склада</p>
            <p className="text-lg font-bold text-foreground tabular-nums truncate">{formatCurrency(kpi.value)}</p>
          </div>
        </div>
        <Link to="/warehouse/inventory" className="bg-card rounded-xl border border-border p-4 flex items-center gap-3 hover:bg-muted/40 transition-colors">
          <div className="size-10 rounded-lg bg-amber-100 dark:bg-amber-500/15 text-amber-600 flex items-center justify-center shrink-0">
            <TriangleAlert className="size-5" />
          </div>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Ниже нормы</p>
            <p className="text-lg font-bold text-amber-600 tabular-nums">
              {kpi.low + kpi.out} поз.
              {kpi.out > 0 && <span className="text-destructive text-sm font-semibold ml-1.5">· {kpi.out} нет</span>}
            </p>
          </div>
        </Link>
        <Link to="/warehouse/suppliers" className="bg-card rounded-xl border border-border p-4 flex items-center gap-3 hover:bg-muted/40 transition-colors">
          <div className="size-10 rounded-lg bg-red-100 dark:bg-red-500/15 text-destructive flex items-center justify-center shrink-0">
            <Wallet className="size-5" />
          </div>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Долг поставщикам</p>
            <p className="text-lg font-bold text-destructive tabular-nums truncate">{formatCurrency(kpi.debt)}</p>
          </div>
        </Link>
      </div>

      {/* ── Быстрые действия ── */}
      <div className="grid grid-cols-3 gap-3">
        {QUICK.map(({ to, label, icon: Icon, primary }) => (
          <Link
            key={to}
            to={to}
            className={`rounded-xl border p-4 flex flex-col items-center gap-2 text-sm font-medium transition-colors ${
              primary
                ? 'bg-primary text-primary-foreground border-transparent hover:bg-primary/90'
                : 'bg-card text-foreground border-border hover:bg-muted/50'
            }`}
          >
            <span className={`size-10 rounded-xl flex items-center justify-center ${primary ? 'bg-white/20' : 'bg-primary/10 text-primary'}`}>
              <Icon className="size-5" />
            </span>
            {label}
          </Link>
        ))}
      </div>

      {/* ── Что закупить ── */}
      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground">Что закупить</h2>
          <Link to="/warehouse/inventory" className="text-xs text-primary font-medium hover:underline">Все остатки</Link>
        </div>
        {toBuy.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            Всё в норме — позиций ниже минимума нет.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {toBuy.map(i => {
              const isOut = i.qty <= 0
              return (
                <Link
                  key={i.id}
                  to="/warehouse/receipts/new"
                  className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors"
                >
                  <span className={`size-2.5 rounded-full shrink-0 ${isOut ? 'bg-destructive' : 'bg-amber-500'}`} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground truncate">{i.name}</p>
                    <p className="text-xs text-muted-foreground">
                      осталось {formatNum(i.qty)} {i.unit} · норма {formatNum(i.minQty)}
                    </p>
                  </div>
                  <span className={`text-xs font-bold px-2 py-1 rounded-md whitespace-nowrap ${
                    isOut ? 'bg-destructive/10 text-destructive' : 'bg-amber-100 dark:bg-amber-500/15 text-amber-600'
                  }`}>
                    нужно {formatNum(i.shortfall)} {i.unit}
                  </span>
                  <ArrowRight className="size-4 text-muted-foreground shrink-0" />
                </Link>
              )
            })}
          </div>
        )}
      </div>

      {/* ── Долги поставщикам ── */}
      {debtors.length > 0 && (
        <div className="bg-card rounded-xl border border-border overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <h2 className="text-sm font-semibold text-foreground">Долги поставщикам</h2>
            <Link to="/warehouse/suppliers" className="text-xs text-primary font-medium hover:underline">Все {kpi.debtors}</Link>
          </div>
          <div className="divide-y divide-border">
            {debtors.map(s => (
              <Link key={s.id} to="/warehouse/suppliers" className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors">
                <div className="size-8 rounded-full bg-muted flex items-center justify-center text-xs font-bold text-foreground/70 shrink-0">
                  {s.name.charAt(0)}
                </div>
                <p className="text-sm font-medium text-foreground truncate flex-1">{s.name}</p>
                <span className="text-sm font-bold text-destructive tabular-nums">{formatCurrency(s.currentDebt)}</span>
                <ChevronRight className="size-4 text-muted-foreground shrink-0" />
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* ── Ссылка в хаб операций ── */}
      <Link
        to="/warehouse/operations"
        className="bg-card rounded-xl border border-border p-4 flex items-center gap-3 hover:bg-muted/40 transition-colors"
      >
        <div className="size-10 rounded-lg bg-muted flex items-center justify-center text-foreground/70 shrink-0">
          <PackageSearch className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">Все операции склада</p>
          <p className="text-xs text-muted-foreground">накладные · возвраты · инвентаризация · п/ф · техкарты · история</p>
        </div>
        <ChevronRight className="size-5 text-muted-foreground shrink-0" />
      </Link>
    </div>
  )
}
