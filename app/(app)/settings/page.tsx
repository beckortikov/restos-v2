'use client'

import { useState, useEffect } from 'react'
import { useAuth } from '@/lib/auth-store'
import { updateRestaurant as updateRestaurantQuery, fetchRestaurantById } from '@/lib/queries'
import { clearRestaurantOperations, clearRestaurantMenu } from '@/lib/queries'
import { toast } from 'sonner'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import * as Sentry from '@sentry/react'
import { Building2, Save, RefreshCw, Copy } from 'lucide-react'
import type { Restaurant } from '@/lib/types'

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
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)

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
      await updateRestaurantQuery(rest.id, { name, address, phone, servicePercent, enforceStockCheck, techCardsEnabled, autoReadyMode, autoReadyBufferMin, pinLockEnabled, pinLockTimeoutMin, supplyAllowNegative })
      toast.success('Настройки сохранены')
      const updated = { ...rest, name, address, phone, servicePercent, enforceStockCheck, techCardsEnabled, autoReadyMode, autoReadyBufferMin, pinLockEnabled, pinLockTimeoutMin, supplyAllowNegative }
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
          payload: { name, address, phone, servicePercent, enforceStockCheck, techCardsEnabled, autoReadyMode, autoReadyBufferMin, pinLockEnabled, pinLockTimeoutMin, supplyAllowNegative },
        },
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-2xl">
      <div>
        <h1 className="text-xl font-bold text-foreground">Настройки ресторана</h1>
        <p className="text-muted-foreground text-sm mt-0.5">Основные данные вашего заведения</p>
      </div>

      <div className="bg-card rounded-xl border border-border p-6 space-y-5">
        <div className="flex items-center gap-3 pb-4 border-b border-border">
          <div className="size-12 rounded-xl bg-primary/10 flex items-center justify-center">
            <Building2 className="size-6 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-foreground">{rest.name}</p>
            <p className="text-xs text-muted-foreground">slug: {rest.slug}</p>
            <button
              onClick={() => {
                navigator.clipboard.writeText(rest.id).then(
                  () => toast.success('ID скопирован'),
                  () => toast.error('Не удалось скопировать'),
                )
              }}
              title="Нажмите чтобы скопировать"
              className="mt-1.5 inline-flex items-center gap-1.5 px-2 py-1 rounded bg-muted hover:bg-border transition-colors text-[11px] font-mono text-muted-foreground hover:text-foreground"
            >
              <span>ID: {rest.id}</span>
              <Copy className="size-3" />
            </button>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium text-foreground block mb-1.5">Название</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full px-3 py-2.5 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div>
            <label className="text-sm font-medium text-foreground block mb-1.5">Адрес</label>
            <input
              value={address}
              onChange={e => setAddress(e.target.value)}
              placeholder="г. Душанбе, ул. ..."
              className="w-full px-3 py-2.5 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div>
            <label className="text-sm font-medium text-foreground block mb-1.5">Телефон</label>
            <input
              value={phone}
              onChange={e => setPhone(e.target.value.replace(/[^\d+\-\s()]/g, ''))}
              placeholder="+992 ..."
              inputMode="tel"
              className="w-full px-3 py-2.5 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div>
            <label className="text-sm font-medium text-foreground block mb-1.5">Процент обслуживания (%)</label>
            <input
              type="number"
              min={0}
              max={30}
              value={servicePercent}
              onChange={e => setServicePercent(Number(e.target.value))}
              className="w-full px-3 py-2.5 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
            <p className="text-xs text-muted-foreground mt-1">Добавляется к счёту при оплате (0 = без обслуживания)</p>
          </div>

          {/* Tech cards toggle */}
          <div className="flex items-center justify-between pt-4 border-t border-border">
            <div className="flex-1 pr-3">
              <p className="text-sm font-medium text-foreground">📋 Учёт по техкартам</p>
              <p className="text-xs text-muted-foreground mt-0.5">Списание ингредиентов со склада, авто-стоп-лист и проверка остатков по рецептам. Отключите чтобы работать без техкарт (COGS берётся из карточки блюда).</p>
            </div>
            <button
              type="button"
              onClick={() => setTechCardsEnabled(!techCardsEnabled)}
              className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${techCardsEnabled ? 'bg-primary' : 'bg-muted-foreground/30'}`}
            >
              <span className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform ${techCardsEnabled ? 'translate-x-5' : ''}`} />
            </button>
          </div>

          {/* Stock check toggle */}
          <div className={`flex items-center justify-between pt-4 border-t border-border ${!techCardsEnabled ? 'opacity-50 pointer-events-none' : ''}`}>
            <div>
              <p className="text-sm font-medium text-foreground">Строгая проверка склада</p>
              <p className="text-xs text-muted-foreground mt-0.5">Блокировать заказ если ингредиентов нет на складе</p>
            </div>
            <button
              type="button"
              onClick={() => setEnforceStockCheck(!enforceStockCheck)}
              disabled={!techCardsEnabled}
              className={`relative w-11 h-6 rounded-full transition-colors ${enforceStockCheck ? 'bg-primary' : 'bg-muted-foreground/30'}`}
            >
              <span className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform ${enforceStockCheck ? 'translate-x-5' : ''}`} />
            </button>
          </div>

          {/* Supplies allow negative stock */}
          <div className="flex items-center justify-between pt-4 border-t border-border">
            <div className="flex-1 pr-3">
              <p className="text-sm font-medium text-foreground">📦 Хозтовары: разрешить минус</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Если включено — при выдаче больше, чем на складе, остаток уходит в минус (долг гасится следующей приёмкой).
                Если выключено — выдача блокируется, пока не оформите приёмку.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setSupplyAllowNegative(!supplyAllowNegative)}
              className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${supplyAllowNegative ? 'bg-primary' : 'bg-muted-foreground/30'}`}
            >
              <span className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform ${supplyAllowNegative ? 'translate-x-5' : ''}`} />
            </button>
          </div>

          {/* Auto-ready mode (no kitchen display) */}
          <div className="pt-4 border-t border-border space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex-1 pr-3">
                <p className="text-sm font-medium text-foreground">🍳 Авто-готовность (без экрана повара)</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Повар работает по чекам с принтера. Заказ автоматически становится &laquo;готов&raquo; через время указанное в техкарте.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setAutoReadyMode(!autoReadyMode)}
                className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${autoReadyMode ? 'bg-primary' : 'bg-muted-foreground/30'}`}
              >
                <span className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform ${autoReadyMode ? 'translate-x-5' : ''}`} />
              </button>
            </div>
            {autoReadyMode && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 space-y-2">
                <label className="text-xs font-medium text-blue-900 block">
                  Запасной буфер времени (мин)
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    max={30}
                    value={autoReadyBufferMin}
                    onChange={e => setAutoReadyBufferMin(Math.max(0, Math.min(30, Number(e.target.value) || 0)))}
                    className="w-20 px-3 py-2 bg-white border border-blue-300 rounded-lg text-sm text-center"
                  />
                  <p className="text-xs text-blue-800 flex-1">
                    Добавляется к максимальному времени готовки из техкарты блюд
                  </p>
                </div>
                <p className="text-[11px] text-blue-700">
                  💡 Например: лагман 30 мин + буфер 5 мин = заказ станет &laquo;готов&raquo; через 35 мин
                </p>
              </div>
            )}
          </div>
        </div>

        {/* PIN Lock */}
        <div className="bg-card rounded-xl border border-border p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-foreground">🔒 PIN-код блокировка POS</p>
              <p className="text-xs text-muted-foreground mt-0.5">POS блокируется после бездействия. Разблокировка по PIN-коду сотрудника.</p>
            </div>
            <button
              type="button"
              onClick={() => setPinLockEnabled(!pinLockEnabled)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${pinLockEnabled ? 'bg-primary' : 'bg-muted'}`}
            >
              <span className={`inline-block size-4 transform rounded-full bg-white transition-transform ${pinLockEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          </div>
          {pinLockEnabled && (
            <div className="bg-blue-50 rounded-lg p-4 space-y-3">
              <div className="flex items-center gap-3">
                <label className="text-xs text-blue-800 font-medium">Блокировать через:</label>
                <select
                  value={pinLockTimeoutMin}
                  onChange={e => setPinLockTimeoutMin(Number(e.target.value))}
                  className="px-3 py-2 bg-white border border-blue-300 rounded-lg text-sm"
                >
                  <option value={1}>1 мин</option>
                  <option value={3}>3 мин</option>
                  <option value={5}>5 мин</option>
                  <option value={10}>10 мин</option>
                </select>
                <p className="text-xs text-blue-800 flex-1">бездействия на POS-терминале</p>
              </div>
              <p className="text-[11px] text-blue-700">
                💡 Назначьте PIN каждому сотруднику в разделе «Права доступа». При блокировке POS показывает цифровую клавиатуру — сотрудник вводит свой PIN и работает от своего имени.
              </p>
            </div>
          )}
        </div>

        <button
          onClick={handleSave}
          disabled={saving}
          className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-5 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          <Save className="size-4" />
          {saving ? 'Сохранение...' : 'Сохранить'}
        </button>
      </div>

      {/* Owner-only: clear operations / menu for this restaurant */}
      {user?.role === 'owner' && (
        <>
          <ClearOpsCard restaurantId={rest.id} restaurantName={rest.name} />
          <ClearMenuCard restaurantId={rest.id} restaurantName={rest.name} />
        </>
      )}
    </div>
  )
}

function ClearOpsCard({ restaurantId, restaurantName }: { restaurantId: string; restaurantName: string }) {
  const [open, setOpen] = useState(false)
  const [confirmName, setConfirmName] = useState('')
  const [busy, setBusy] = useState(false)

  return (
    <>
      <div className="bg-amber-50 rounded-xl border-2 border-amber-200 p-5 space-y-3">
        <h2 className="text-sm font-semibold text-amber-800">Сброс операций ресторана</h2>
        <p className="text-xs text-amber-700">
          Удалит все заказы, смены, финансовые операции, движения склада, бронирования, журнал действий, инвентаризации, накладные, списания, заготовки. Сбросит балансы счетов, статистику клиентов и поставщиков, статус столов в «Свободен».
          <br /><strong>Сохранится:</strong> меню, ингредиенты (включая остатки), тех.карты, столы, зоны, сотрудники, поставщики, клиенты (без статистики), счета, активы/пассивы.
        </p>
        <button
          onClick={() => { setConfirmName(''); setOpen(true) }}
          className="inline-flex items-center gap-2 rounded-lg bg-amber-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-amber-700"
        >
          <RefreshCw className="size-4" />
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
                  toast.error(e instanceof Error ? e.message : 'Ошибка сброса операций')
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
      <div className="bg-rose-50 rounded-xl border-2 border-rose-200 p-5 space-y-3">
        <h2 className="text-sm font-semibold text-rose-800">Очистка меню</h2>
        <p className="text-xs text-rose-700">
          Удалит все блюда, категории, тех.карты, модификаторы и заготовки. Старые
          заказы сохранятся (с замороженными названиями), их связь с меню будет
          снята. <strong>Не трогает</strong> ингредиенты, остатки склада, столы,
          сотрудников, поставщиков, клиентов, счета.
        </p>
        <button
          onClick={() => { setConfirmName(''); setOpen(true) }}
          className="inline-flex items-center gap-2 rounded-lg bg-rose-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-rose-700"
        >
          <RefreshCw className="size-4" />
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
                  toast.error(e instanceof Error ? e.message : 'Ошибка очистки меню')
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
