'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { formatCurrency } from '@/lib/helpers'
import { type FinancialAccount, type FinancialOperation, type Supplier, type RecurringPayment, finopCategoryLabel } from '@/lib/types'
import { fetchFinancialAccounts, fetchFinancialOperations, fetchSuppliers } from '@/lib/queries'
import { fetchRecurringPayments } from '@/lib/queries/recurring-payments'
import { useDataSync } from '@/hooks/use-data-sync'
import {
  Wallet, TrendingUp, TrendingDown, Scale, CalendarClock, ChevronRight,
  PieChart, Users, AlertTriangle,
} from 'lucide-react'

// «Финансы → Обзор» — приборная панель раздела: с чего начинается день.
// Собирается из уже существующих запросов (счета, операции, поставщики,
// регулярные платежи) — отдельного бэк-эндпоинта не нужно.

function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export default function FinanceOverviewPage() {
  const [accounts, setAccounts] = useState<FinancialAccount[]>([])
  const [ops, setOps] = useState<FinancialOperation[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [payments, setPayments] = useState<RecurringPayment[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    // Каждый источник независимо: падение одного не гасит весь экран.
    fetchFinancialAccounts().then(setAccounts).catch(() => {})
    fetchFinancialOperations().then(setOps).catch(() => {})
    fetchSuppliers().then(setSuppliers).catch(() => {})
    fetchRecurringPayments().then(setPayments).catch(() => {})
  }, [])

  useEffect(() => { load().finally(() => setLoading(false)) }, [load])
  useDataSync(['financial_operations', 'financial_accounts', 'suppliers'], load)

  const today = ymd(new Date())

  const totalBalance = useMemo(() => accounts.reduce((s, a) => s + a.balance, 0), [accounts])

  // Приход/расход за сегодня. Переводы между счетами не считаем — они не
  // меняют общий остаток и раздували бы обе цифры.
  const todayFlow = useMemo(() => {
    let inSum = 0
    let outSum = 0
    for (const o of ops) {
      if ((o.date ?? '').slice(0, 10) !== today) continue
      if (o.activity === 'financial') continue
      if (o.type === 'in') inSum += o.amount
      else if (o.type === 'out') outSum += o.amount
    }
    return { in: inSum, out: outSum, net: inSum - outSum }
  }, [ops, today])

  const debt = useMemo(() => {
    const list = suppliers.filter((s) => s.currentDebt > 0)
    return { total: list.reduce((s, x) => s + x.currentDebt, 0), count: list.length }
  }, [suppliers])

  // Ближайшие платежи: активные, по сроку; просроченные — вперёд.
  const upcoming = useMemo(() => {
    return payments
      .filter((p) => p.active && p.nextDue)
      .sort((a, b) => (a.nextDue ?? '').localeCompare(b.nextDue ?? ''))
      .slice(0, 4)
      .map((p) => {
        const due = p.nextDue ?? ''
        const days = Math.round((new Date(due).getTime() - new Date(today).getTime()) / 86400000)
        return { ...p, days, overdue: days < 0 }
      })
  }, [payments, today])

  if (loading) {
    return <div className="p-6 flex items-center justify-center h-64"><div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>
  }

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5 max-w-5xl mx-auto">
      <div>
        <h1 className="text-xl font-bold text-foreground">Финансы</h1>
        <p className="text-muted-foreground text-sm mt-0.5">Обзор · деньги, долги и ближайшие платежи</p>
      </div>

      {/* ── Главные цифры ── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Link to="/finance/accounts" className="bg-card rounded-xl border border-border p-4 flex items-center gap-3 hover:bg-muted/40 transition-colors">
          <div className="size-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <Wallet className="size-5" />
          </div>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Деньги на счетах</p>
            <p className="text-lg font-bold text-foreground tabular-nums truncate">{formatCurrency(totalBalance)}</p>
          </div>
        </Link>

        <div className="bg-card rounded-xl border border-border p-4 flex items-center gap-3">
          <div className={`size-10 rounded-lg flex items-center justify-center shrink-0 ${todayFlow.net >= 0 ? 'bg-emerald-100 dark:bg-emerald-500/15 text-emerald-600' : 'bg-destructive/10 text-destructive'}`}>
            {todayFlow.net >= 0 ? <TrendingUp className="size-5" /> : <TrendingDown className="size-5" />}
          </div>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Сегодня</p>
            <p className={`text-lg font-bold tabular-nums truncate ${todayFlow.net >= 0 ? 'text-emerald-600' : 'text-destructive'}`}>
              {todayFlow.net >= 0 ? '+' : ''}{formatCurrency(todayFlow.net)}
            </p>
            <p className="text-[11px] text-muted-foreground tabular-nums">
              приход {formatCurrency(todayFlow.in)} · расход {formatCurrency(todayFlow.out)}
            </p>
          </div>
        </div>

        <Link to="/warehouse/suppliers" className="bg-card rounded-xl border border-border p-4 flex items-center gap-3 hover:bg-muted/40 transition-colors">
          <div className="size-10 rounded-lg bg-red-100 dark:bg-red-500/15 text-destructive flex items-center justify-center shrink-0">
            <Scale className="size-5" />
          </div>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Долг поставщикам</p>
            <p className="text-lg font-bold text-destructive tabular-nums truncate">{formatCurrency(debt.total)}</p>
            {debt.count > 0 && <p className="text-[11px] text-muted-foreground">{debt.count} поставщик{debt.count === 1 ? '' : debt.count < 5 ? 'а' : 'ов'}</p>}
          </div>
        </Link>
      </div>

      {/* ── Счета ── */}
      {accounts.length > 0 && (
        <div className="bg-card rounded-xl border border-border overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <h2 className="text-sm font-semibold text-foreground">Счета</h2>
            <Link to="/finance/accounts" className="text-xs text-primary font-medium hover:underline">Все счета</Link>
          </div>
          <div className="divide-y divide-border">
            {accounts.map((a) => (
              <Link key={a.id} to="/finance/accounts" className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors">
                <div className="size-8 rounded-lg bg-muted flex items-center justify-center text-foreground/70 shrink-0">
                  <Wallet className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground truncate">{a.name}</p>
                  <p className="text-xs text-muted-foreground">{a.type === 'cash' ? 'Наличные' : a.type === 'bank' ? 'Банк' : a.type}</p>
                </div>
                <span className={`text-sm font-bold tabular-nums ${a.balance < 0 ? 'text-destructive' : 'text-foreground'}`}>
                  {formatCurrency(a.balance)}
                </span>
                <ChevronRight className="size-4 text-muted-foreground shrink-0" />
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* ── Ближайшие платежи ── */}
      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
            <CalendarClock className="size-4 text-primary" />
            Ближайшие платежи
          </h2>
          <Link to="/finance/payments" className="text-xs text-primary font-medium hover:underline">Все платежи</Link>
        </div>
        {upcoming.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">Запланированных платежей нет</div>
        ) : (
          <div className="divide-y divide-border">
            {upcoming.map((p) => (
              <Link key={p.id} to="/finance/payments" className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors">
                {p.overdue
                  ? <AlertTriangle className="size-4 text-destructive shrink-0" />
                  : <CalendarClock className="size-4 text-muted-foreground shrink-0" />}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground truncate">{p.name}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {finopCategoryLabel(p.category)}
                    {p.counterparty ? ` · ${p.counterparty}` : ''}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-0.5 shrink-0">
                  <span className="text-sm font-bold text-foreground tabular-nums">{formatCurrency(p.amount)}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                    p.overdue
                      ? 'bg-destructive/10 text-destructive'
                      : p.days <= 3
                        ? 'bg-amber-100 dark:bg-amber-500/15 text-amber-600'
                        : 'bg-muted text-muted-foreground'
                  }`}>
                    {p.overdue ? `просрочен ${Math.abs(p.days)} дн.` : p.days === 0 ? 'сегодня' : `через ${p.days} дн.`}
                  </span>
                </div>
                <ChevronRight className="size-4 text-muted-foreground shrink-0" />
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* ── Разделы ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { to: '/finance/cashflow', label: 'Отчёты', hint: 'ДДС · ОПиУ · Баланс', icon: TrendingUp },
          { to: '/finance/accounts', label: 'Деньги', hint: 'счета · платежи', icon: Wallet },
          { to: '/finance/expenses', label: 'Расходы и бюджет', hint: 'статьи · план/факт', icon: PieChart },
          { to: '/finance/payroll', label: 'Персонал', hint: 'зарплата · обслуживание', icon: Users },
        ].map(({ to, label, hint, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            className="bg-card rounded-xl border border-border p-4 flex flex-col gap-2 hover:bg-muted/40 transition-colors"
          >
            <span className="size-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
              <Icon className="size-[18px]" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{label}</p>
              <p className="text-xs text-muted-foreground truncate">{hint}</p>
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}
