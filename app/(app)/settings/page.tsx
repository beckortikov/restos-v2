'use client'

import { useState, useEffect } from 'react'
import { useAuth } from '@/lib/auth-store'
import { updateRestaurant as updateRestaurantQuery, fetchRestaurantById } from '@/lib/queries'
import { clearRestaurantOperations, clearRestaurantMenu } from '@/lib/queries'
import { toast } from 'sonner'
import { humanizeError } from '@/lib/errors'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import * as Sentry from '@sentry/react'
import { Building2, Save, RefreshCw, Copy, ChevronDown, ChevronRight, X } from 'lucide-react'
import type { Restaurant } from '@/lib/types'

// ─── Reusable bits ───────────────────────────────────────────────────────────

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-card rounded-xl border border-border p-4 space-y-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      <div className="space-y-3">{children}</div>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs font-medium text-foreground block mb-1">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground mt-1">{hint}</p>}
    </div>
  )
}

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onChange}
      disabled={disabled}
      className={`relative w-10 h-5.5 h-[22px] rounded-full transition-colors shrink-0 ${checked ? 'bg-primary' : 'bg-muted-foreground/30'} ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
    >
      <span className={`absolute top-0.5 left-0.5 size-[18px] rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-[18px]' : ''}`} />
    </button>
  )
}

function ToggleRow({ title, hint, checked, onChange, disabled }: { title: string; hint?: string; checked: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <div className={`flex items-start justify-between gap-3 ${disabled ? 'opacity-50' : ''}`}>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-foreground">{title}</p>
        {hint && <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">{hint}</p>}
      </div>
      <Toggle checked={checked} onChange={onChange} disabled={disabled} />
    </div>
  )
}

const inputCls = 'w-full px-2.5 py-1.5 bg-background border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/30'

// ─── Page ────────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const { user, restaurant: ctxRestaurant, canAccessRoles, updateRestaurant: updateAuthRestaurant } = useAuth()
  const [rest, setRest] = useState<Restaurant | null>(null)
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [phone, setPhone] = useState('')
  const [servicePercent, setServicePercent] = useState(10)
  const [enforceStockCheck, setEnforceStockCheck] = useState(false)
  const [techCardsEnabled, setTechCardsEnabled] = useState(true)
  const [autoReadyMode, setAutoReadyMode] = useState(false)
  const [autoReadyBufferMin, setAutoReadyBufferMin] = useState(5)
  const [pinLockEnabled, setPinLockEnabled] = useState(false)
  const [pinLockTimeoutMin, setPinLockTimeoutMin] = useState(5)
  const [supplyAllowNegative, setSupplyAllowNegative] = useState(true)
  const [onScreenKeyboardEnabled, setOnScreenKeyboardEnabled] = useState(false)
  // Режим обслуживания (041 + 052): столы в зале (выкл = фастфуд) + доставка.
  // Отдельного тумблера «кухня после оплаты» больше нет — фастфуд включает это
  // поведение сам (см. lib/order-types.ts isPrepayMode и серверный kitchenOnPay).
  const [tablesEnabled, setTablesEnabled] = useState(true)
  const [deliveryEnabled, setDeliveryEnabled] = useState(false)
  const [deliveryContactsRequired, setDeliveryContactsRequired] = useState(true)
  const [posV2Default, setPosV2Default] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [advancedOpen, setAdvancedOpen] = useState(false)

  // Always load fresh from DB to get latest settings
  useEffect(() => {
    const rid = ctxRestaurant?.id || user?.restaurantId
    if (!rid) { setLoading(false); return }
    fetchRestaurantById(rid)
      .then(r => {
        if (r) {
          setRest(r)
          setName(r.name)
          setAddress(r.address || '')
          setPhone(r.phone || '')
          setServicePercent(r.servicePercent)
          setEnforceStockCheck(r.enforceStockCheck ?? false)
          setTechCardsEnabled(r.techCardsEnabled ?? true)
          setAutoReadyMode(r.autoReadyMode ?? false)
          setAutoReadyBufferMin(r.autoReadyBufferMin ?? 5)
          setPinLockEnabled(r.pinLockEnabled ?? false)
          setPinLockTimeoutMin(r.pinLockTimeoutMin ?? 5)
          setSupplyAllowNegative(r.supplyAllowNegative ?? true)
          setOnScreenKeyboardEnabled(r.onScreenKeyboardEnabled ?? false)
          setTablesEnabled(r.tablesEnabled ?? true)
          setDeliveryEnabled(r.deliveryEnabled ?? false)
          setDeliveryContactsRequired(r.deliveryContactsRequired ?? true)
          setPosV2Default(r.posV2Default ?? false)
        }
      })
      .catch(e => console.error('Failed to load restaurant:', e))
      .finally(() => setLoading(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxRestaurant?.id, user?.restaurantId])

  if (!canAccessRoles(['manager'])) {
    return (
      <div className="p-6 flex items-center justify-center h-64">
        <p className="text-muted-foreground">Нет доступа</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-64">
        <div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    )
  }

  if (!rest) {
    return (
      <div className="p-6 flex items-center justify-center h-64">
        <p className="text-muted-foreground">Ресторан не найден. Проверьте привязку пользователя.</p>
      </div>
    )
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await updateRestaurantQuery(rest.id, { name, address, phone, servicePercent, enforceStockCheck, techCardsEnabled, autoReadyMode, autoReadyBufferMin, pinLockEnabled, pinLockTimeoutMin, supplyAllowNegative, onScreenKeyboardEnabled, tablesEnabled, deliveryEnabled, deliveryContactsRequired, posV2Default })
      toast.success('Настройки сохранены')
      const updated = { ...rest, name, address, phone, servicePercent, enforceStockCheck, techCardsEnabled, autoReadyMode, autoReadyBufferMin, pinLockEnabled, pinLockTimeoutMin, supplyAllowNegative, onScreenKeyboardEnabled, tablesEnabled, deliveryEnabled, deliveryContactsRequired, posV2Default }
      setRest(updated)
      updateAuthRestaurant(updated)
    } catch (e) {
      const msg = e instanceof Error
        ? e.message
        : (e && typeof e === 'object' && 'message' in e && typeof (e as { message: unknown }).message === 'string')
          ? (e as { message: string }).message
          : JSON.stringify(e)
      toast.error('Ошибка сохранения: ' + msg)
      console.error('[settings.save] failed', e)
      Sentry.captureException(e, {
        tags: { component: 'settings.save' },
        extra: {
          restaurantId: rest.id,
          payload: { name, address, phone, servicePercent, enforceStockCheck, techCardsEnabled, autoReadyMode, autoReadyBufferMin, pinLockEnabled, pinLockTimeoutMin, supplyAllowNegative, onScreenKeyboardEnabled, tablesEnabled, deliveryEnabled, deliveryContactsRequired, posV2Default },
        },
      })
    } finally {
      setSaving(false)
    }
  }

  const handleReset = () => {
    if (!rest) return
    setName(rest.name)
    setAddress(rest.address || '')
    setPhone(rest.phone || '')
    setServicePercent(rest.servicePercent)
    setEnforceStockCheck(rest.enforceStockCheck ?? false)
    setTechCardsEnabled(rest.techCardsEnabled ?? true)
    setAutoReadyMode(rest.autoReadyMode ?? false)
    setAutoReadyBufferMin(rest.autoReadyBufferMin ?? 5)
    setPinLockEnabled(rest.pinLockEnabled ?? false)
    setPinLockTimeoutMin(rest.pinLockTimeoutMin ?? 5)
    setSupplyAllowNegative(rest.supplyAllowNegative ?? true)
    setOnScreenKeyboardEnabled(rest.onScreenKeyboardEnabled ?? false)
    setTablesEnabled(rest.tablesEnabled ?? true)
    setDeliveryEnabled(rest.deliveryEnabled ?? false)
    setDeliveryContactsRequired(rest.deliveryContactsRequired ?? true)
    setPosV2Default(rest.posV2Default ?? false)
  }

  return (
    <div className="flex flex-col h-full">
      {/* Sticky header */}
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b border-border px-4 md:px-6 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="size-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <Building2 className="size-5 text-primary" />
          </div>
          <div className="min-w-0">
            <h1 className="text-base font-bold text-foreground truncate">Настройки ресторана</h1>
            <button
              onClick={() => {
                navigator.clipboard.writeText(rest.id).then(
                  () => toast.success('ID скопирован'),
                  () => toast.error('Не удалось скопировать'),
                )
              }}
              title="ID ресторана — скопировать"
              className="inline-flex items-center gap-1 text-[10px] font-mono text-muted-foreground hover:text-foreground"
            >
              slug: {rest.slug} · <span>ID</span> <Copy className="size-2.5" />
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleReset}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors disabled:opacity-50"
          >
            <X className="size-3.5" />
            Сбросить
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            <Save className="size-3.5" />
            {saving ? 'Сохранение…' : 'Сохранить'}
          </button>
        </div>
      </div>

      <div className="p-4 md:p-6 space-y-4 max-w-6xl w-full">
        {/* Two-column grid of cards */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Основное */}
          <Card title="Основное">
            <Field label="Название">
              <input value={name} onChange={e => setName(e.target.value)} className={inputCls} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Валюта">
                <input value={rest.currency} disabled className={`${inputCls} opacity-60`} />
              </Field>
              <Field label="Часовой пояс">
                <input value={rest.timezone} disabled className={`${inputCls} opacity-60`} />
              </Field>
            </div>
          </Card>

          {/* Адрес и контакты */}
          <Card title="Адрес и контакты">
            <Field label="Адрес">
              <input value={address} onChange={e => setAddress(e.target.value)} placeholder="г. Душанбе, ул. ..." className={inputCls} />
            </Field>
            <Field label="Телефон">
              <input
                value={phone}
                onChange={e => setPhone(e.target.value.replace(/[^\d+\-\s()]/g, ''))}
                placeholder="+992 ..."
                inputMode="tel"
                className={inputCls}
              />
            </Field>
          </Card>

          {/* Цены и сервис */}
          <Card title="Цены и сервис">
            <Field label="Процент обслуживания (%)" hint="Добавляется к счёту при оплате (0 = без обслуживания)">
              <input
                type="number"
                min={0}
                max={30}
                value={servicePercent}
                onChange={e => setServicePercent(Number(e.target.value))}
                className={inputCls}
              />
            </Field>
          </Card>

          {/* Склад и техкарты */}
          <Card title="Склад и техкарты">
            <ToggleRow
              title="📋 Учёт по техкартам"
              hint="Списание ингредиентов, авто-стоп-лист, проверка остатков по рецептам."
              checked={techCardsEnabled}
              onChange={() => setTechCardsEnabled(!techCardsEnabled)}
            />
            <div className="border-t border-border pt-3">
              <ToggleRow
                title="Строгая проверка склада (контроль остатков)"
                hint={techCardsEnabled
                  ? 'ВКЛ — блокировать заказ при нехватке ингредиентов и требовать техкарту. ВЫКЛ — склад может уходить в минус, а блюда без техкарты продаются свободно (склад только для части позиций).'
                  : 'Доступно при включённом «Учёте по техкартам».'}
                checked={enforceStockCheck}
                onChange={() => setEnforceStockCheck(!enforceStockCheck)}
                disabled={!techCardsEnabled}
              />
            </div>
            <div className="border-t border-border pt-3">
              <ToggleRow
                title="📦 Хозтовары: разрешить минус"
                hint="Выдача больше, чем на складе → остаток в минус (долг гасится приёмкой)."
                checked={supplyAllowNegative}
                onChange={() => setSupplyAllowNegative(!supplyAllowNegative)}
              />
            </div>
          </Card>

          {/* Workflow */}
          <Card title="Workflow кухни">
            <ToggleRow
              title="🍳 Авто-готовность (без экрана повара)"
              hint="Повар работает по чекам с принтера. Заказ авто-готов через время из техкарты."
              checked={autoReadyMode}
              onChange={() => setAutoReadyMode(!autoReadyMode)}
            />
            {autoReadyMode && (
              <div className="bg-blue-50 border border-blue-200 rounded-md p-2.5">
                <label className="text-[11px] font-medium text-blue-900 block mb-1.5">
                  Запасной буфер (мин)
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    max={30}
                    value={autoReadyBufferMin}
                    onChange={e => setAutoReadyBufferMin(Math.max(0, Math.min(30, Number(e.target.value) || 0)))}
                    className="w-16 px-2 py-1 bg-white border border-blue-300 rounded text-sm text-center"
                  />
                  <p className="text-[11px] text-blue-800 flex-1">
                    Добавляется к макс. времени готовки из техкарты
                  </p>
                </div>
              </div>
            )}
          </Card>

          {/* Безопасность */}
          <Card title="Безопасность">
            <ToggleRow
              title="🔒 PIN-блокировка POS"
              hint="POS блокируется после бездействия. Разблокировка по PIN сотрудника."
              checked={pinLockEnabled}
              onChange={() => setPinLockEnabled(!pinLockEnabled)}
            />
            {pinLockEnabled && (
              <div className="bg-blue-50 border border-blue-200 rounded-md p-2.5 flex items-center gap-2">
                <label className="text-[11px] text-blue-900 font-medium">Через:</label>
                <select
                  value={pinLockTimeoutMin}
                  onChange={e => setPinLockTimeoutMin(Number(e.target.value))}
                  className="px-2 py-1 bg-white border border-blue-300 rounded text-xs"
                >
                  <option value={1}>1 мин</option>
                  <option value={3}>3 мин</option>
                  <option value={5}>5 мин</option>
                  <option value={10}>10 мин</option>
                </select>
                <p className="text-[11px] text-blue-800 flex-1">бездействия на терминале</p>
              </div>
            )}
          </Card>

          {/* Режим обслуживания — как ресторан обслуживает гостей (зал/фастфуд). */}
          <Card title="Режим обслуживания">
            <ToggleRow
              title="🍽️ Столы в зале"
              hint="Включено — классический зал: заказ «в зал» привязывается к столу, группы, карта зала, оплата в конце. Выключите для фастфуда: заказ по номеру без стола, создать его без оплаты нельзя — чек гостю и бегунок на кухню печатаются вместе по факту оплаты."
              checked={tablesEnabled}
              onChange={() => setTablesEnabled(!tablesEnabled)}
            />
            <ToggleRow
              title="🛵 Доставка"
              hint="Добавляет «Доставка» третьим типом заказа рядом с «Зал» и «С собой». Флоу тот же, что у «С собой». Выключение не прячет уже созданные заказы-доставки — только убирает выбор типа для новых."
              checked={deliveryEnabled}
              onChange={() => setDeliveryEnabled(!deliveryEnabled)}
            />
            {deliveryEnabled && (
              <div className="ml-4 pl-3 border-l-2 border-border">
                <ToggleRow
                  title="📞 Спрашивать телефон и адрес"
                  hint="Перед оплатой заказа-доставки касса просит телефон и адрес клиента — они печатаются на бегунке курьеру. Выключите, если контакты ведутся вне кассы."
                  checked={deliveryContactsRequired}
                  onChange={() => setDeliveryContactsRequired(!deliveryContactsRequired)}
                />
              </div>
            )}
          </Card>

          {/* Интерфейс */}
          <Card title="Интерфейс">
            <ToggleRow
              title="⌨️ Экранная клавиатура"
              hint="Виртуальная клавиатура (iiko-style) при вводе на POS, смене и карте зала. Нужна на тач-терминалах без физической клавиатуры."
              checked={onScreenKeyboardEnabled}
              onChange={() => setOnScreenKeyboardEnabled(!onScreenKeyboardEnabled)}
            />
            <ToggleRow
              title="✨ Новый POS по умолчанию"
              hint="Кассы открывают новый интерфейс (POS 2) без ручного включения на каждой. Касса может переопределить локально в своих настройках."
              checked={posV2Default}
              onChange={() => setPosV2Default(!posV2Default)}
            />
          </Card>
        </div>

        {/* Дополнительно — collapsible (owner-only danger zone) */}
        {user?.role === 'owner' && (
          <div className="bg-card rounded-xl border border-border overflow-hidden">
            <button
              type="button"
              onClick={() => setAdvancedOpen(v => !v)}
              className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-muted/40 transition-colors"
            >
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Дополнительно</p>
                <p className="text-xs text-muted-foreground/80 mt-0.5">Опасная зона — сброс данных ресторана</p>
              </div>
              {advancedOpen ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}
            </button>
            {advancedOpen && (
              <div className="border-t border-border p-4 grid grid-cols-1 lg:grid-cols-2 gap-3">
                <ClearOpsCard restaurantId={rest.id} restaurantName={rest.name} />
                <ClearMenuCard restaurantId={rest.id} restaurantName={rest.name} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function ClearOpsCard({ restaurantId, restaurantName }: { restaurantId: string; restaurantName: string }) {
  const [open, setOpen] = useState(false)
  const [confirmName, setConfirmName] = useState('')
  const [busy, setBusy] = useState(false)

  return (
    <>
      <div className="bg-amber-50 rounded-lg border border-amber-200 p-3 space-y-2">
        <h3 className="text-xs font-semibold text-amber-800">Сброс операций ресторана</h3>
        <p className="text-[11px] text-amber-700 leading-snug">
          Удалит все заказы, смены, фин. операции, движения склада, бронирования, журнал, инвентаризации, накладные, списания, заготовки. Сохранит меню, ингредиенты, тех.карты, столы, сотрудников.
        </p>
        <button
          onClick={() => { setConfirmName(''); setOpen(true) }}
          className="inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700"
        >
          <RefreshCw className="size-3.5" />
          Сбросить операции
        </button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-amber-700">Сброс операций ресторана</DialogTitle>
            <DialogDescription>
              Все операционные данные будут удалены. Меню, склад, сотрудники, столы и зоны останутся. Действие необратимо — после подтверждения данные будут также удалены из облака.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-foreground">
              Для подтверждения введите название ресторана: <strong>{restaurantName}</strong>
            </p>
            <input
              value={confirmName}
              onChange={e => setConfirmName(e.target.value)}
              placeholder={restaurantName}
              className="w-full px-3 py-2.5 text-sm bg-background border border-amber-300 rounded-lg focus:border-amber-500 focus:ring-1 focus:ring-amber-500 outline-none"
            />
          </div>
          <DialogFooter>
            <button onClick={() => setOpen(false)} className="px-4 py-2 text-sm font-medium bg-card border border-border rounded-lg hover:bg-muted">
              Отмена
            </button>
            <button
              disabled={confirmName !== restaurantName || busy}
              onClick={async () => {
                setBusy(true)
                try {
                  const result = await clearRestaurantOperations(restaurantId)
                  const total = Object.values(result.counts).reduce((s, n) => s + n, 0)
                  toast.success(`Операции сброшены (${total} записей удалено)`)
                  setOpen(false)
                } catch (e) {
                  toast.error(humanizeError(e, 'Ошибка сброса операций'))
                } finally {
                  setBusy(false)
                }
              }}
              className="px-4 py-2 text-sm font-medium text-white bg-amber-600 rounded-lg hover:bg-amber-700 disabled:opacity-50 flex items-center gap-2"
            >
              <RefreshCw className={`size-4 ${busy ? 'animate-spin' : ''}`} />
              {busy ? 'Сброс...' : 'Сбросить операции'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function ClearMenuCard({ restaurantId, restaurantName }: { restaurantId: string; restaurantName: string }) {
  const [open, setOpen] = useState(false)
  const [confirmName, setConfirmName] = useState('')
  const [busy, setBusy] = useState(false)

  return (
    <>
      <div className="bg-rose-50 rounded-lg border border-rose-200 p-3 space-y-2">
        <h3 className="text-xs font-semibold text-rose-800">Очистка меню</h3>
        <p className="text-[11px] text-rose-700 leading-snug">
          Удалит все блюда, категории, тех.карты, модификаторы и заготовки. Старые заказы сохранятся (с замороженными названиями). Не трогает ингредиенты, склад, столы, сотрудников.
        </p>
        <button
          onClick={() => { setConfirmName(''); setOpen(true) }}
          className="inline-flex items-center gap-1.5 rounded-md bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-700"
        >
          <RefreshCw className="size-3.5" />
          Очистить меню
        </button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-rose-700">Очистка меню ресторана</DialogTitle>
            <DialogDescription>
              Все блюда, категории, тех.карты, модификаторы и заготовки будут удалены. Действие необратимо — данные будут также удалены из облака.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-foreground">
              Для подтверждения введите название ресторана: <strong>{restaurantName}</strong>
            </p>
            <input
              value={confirmName}
              onChange={e => setConfirmName(e.target.value)}
              placeholder={restaurantName}
              className="w-full px-3 py-2.5 text-sm bg-background border border-rose-300 rounded-lg focus:border-rose-500 focus:ring-1 focus:ring-rose-500 outline-none"
            />
          </div>
          <DialogFooter>
            <button onClick={() => setOpen(false)} className="px-4 py-2 text-sm font-medium bg-card border border-border rounded-lg hover:bg-muted">
              Отмена
            </button>
            <button
              disabled={confirmName !== restaurantName || busy}
              onClick={async () => {
                setBusy(true)
                try {
                  const result = await clearRestaurantMenu(restaurantId)
                  const total = Object.values(result.counts).reduce((s, n) => s + n, 0)
                  toast.success(`Меню очищено (${total} записей удалено)`)
                  setOpen(false)
                } catch (e) {
                  toast.error(humanizeError(e, 'Ошибка очистки меню'))
                } finally {
                  setBusy(false)
                }
              }}
              className="px-4 py-2 text-sm font-medium text-white bg-rose-600 rounded-lg hover:bg-rose-700 disabled:opacity-50 flex items-center gap-2"
            >
              <RefreshCw className={`size-4 ${busy ? 'animate-spin' : ''}`} />
              {busy ? 'Очистка...' : 'Очистить меню'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
