'use client'

import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { UtensilsCrossed, AlertCircle, CheckCircle2, ArrowRight } from 'lucide-react'
import { api, unwrap, setV4RestaurantId, setV4Token, v4ErrorMessage } from '@/lib/api'

type Mode = 'check' | 'init' | 'connect' | 'done'

export default function BootstrapPage() {
  const navigate = useNavigate()
  const [mode, setMode] = useState<Mode>('check')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // Init form
  const [restName, setRestName] = useState('')
  const [ownerName, setOwnerName] = useState('Владелец')
  const [ownerPin, setOwnerPin] = useState('')
  const [currency, setCurrency] = useState('UZS')
  const [timezone, setTimezone] = useState('Asia/Tashkent')

  // Connect (existing) form
  const [restId, setRestId] = useState('')

  useEffect(() => {
    let cancel = false
    ;(async () => {
      try {
        const s: any = await unwrap(api.GET('/api/v1/bootstrap/status'))
        if (cancel) return
        setMode(s.initialized ? 'connect' : 'init')
      } catch (e) {
        if (cancel) return
        setError('Не удаётся связаться с сервером: ' + v4ErrorMessage(e))
        setMode('init')
      }
    })()
    return () => { cancel = true }
  }, [])

  async function runInit(e: React.FormEvent) {
    e.preventDefault()
    if (!restName.trim()) return setError('Введите название ресторана')
    if (ownerPin.length < 4) return setError('PIN должен быть не короче 4 цифр')
    setLoading(true); setError('')
    try {
      const r: any = await unwrap(api.POST('/api/v1/bootstrap', {
        body: {
          restaurant_name: restName.trim(),
          owner_name: ownerName.trim() || 'Владелец',
          owner_pin: ownerPin,
          currency,
          timezone,
        } as any,
      }))
      const rid = r.restaurant?.id
      if (!rid) throw new Error('сервер не вернул restaurant.id')
      setV4RestaurantId(rid)
      // Авто-логин под только что созданным владельцем.
      const login: any = await unwrap(api.POST('/api/v1/auth/login', {
        body: { restaurant_id: rid, pin: ownerPin } as any,
      }))
      setV4Token(login.token)
      setMode('done')
      setTimeout(() => navigate('/dashboard', { replace: true }), 800)
    } catch (e) {
      setError('Не удалось создать ресторан: ' + v4ErrorMessage(e))
    } finally {
      setLoading(false)
    }
  }

  function saveExistingRestaurantId(e: React.FormEvent) {
    e.preventDefault()
    if (!restId.trim()) return setError('Вставьте restaurant_id')
    setV4RestaurantId(restId.trim())
    navigate('/login', { replace: true })
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4 py-8">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center mb-6">
          <div className="size-14 rounded-2xl bg-primary flex items-center justify-center mb-4">
            <UtensilsCrossed className="size-7 text-primary-foreground" />
          </div>
          <h1 className="text-2xl font-bold">RestOS — Инициализация</h1>
          <p className="text-muted-foreground text-sm mt-1 text-center">
            {mode === 'init' && 'Заведите ресторан и аккаунт владельца'}
            {mode === 'connect' && 'База уже создана — введите restaurant_id'}
            {mode === 'done' && 'Готово!'}
            {mode === 'check' && 'Проверяем сервер…'}
          </p>
        </div>

        {error && (
          <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 px-3 py-2.5 rounded-lg mb-4">
            <AlertCircle className="size-4 shrink-0" />
            {error}
          </div>
        )}

        {mode === 'check' && (
          <div className="flex items-center justify-center py-12">
            <div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
          </div>
        )}

        {mode === 'init' && (
          <form onSubmit={runInit} className="bg-card rounded-2xl border border-border p-6 space-y-4 shadow-sm">
            <div>
              <label className="block text-sm font-medium mb-1.5">Название ресторана</label>
              <input
                type="text"
                value={restName}
                onChange={e => setRestName(e.target.value)}
                placeholder="Например: Кафе Пушкин"
                className="w-full px-4 py-3 bg-background border border-input rounded-xl"
                autoFocus
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1.5">Валюта</label>
                <input
                  type="text"
                  value={currency}
                  onChange={e => setCurrency(e.target.value)}
                  className="w-full px-4 py-3 bg-background border border-input rounded-xl"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">Часовой пояс</label>
                <input
                  type="text"
                  value={timezone}
                  onChange={e => setTimezone(e.target.value)}
                  className="w-full px-4 py-3 bg-background border border-input rounded-xl"
                />
              </div>
            </div>
            <div className="border-t border-border pt-4 space-y-3">
              <div>
                <label className="block text-sm font-medium mb-1.5">Имя владельца</label>
                <input
                  type="text"
                  value={ownerName}
                  onChange={e => setOwnerName(e.target.value)}
                  className="w-full px-4 py-3 bg-background border border-input rounded-xl"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">PIN (4–8 цифр)</label>
                <input
                  type="password"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={ownerPin}
                  onChange={e => setOwnerPin(e.target.value.replace(/[^0-9]/g, '').slice(0, 8))}
                  placeholder="••••"
                  className="w-full px-4 py-3 bg-background border border-input rounded-xl font-mono text-lg tracking-widest"
                />
              </div>
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 bg-primary text-primary-foreground py-3.5 rounded-xl text-base font-semibold hover:bg-primary/90 disabled:opacity-60 transition-colors"
            >
              {loading ? (
                <div className="size-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
              ) : (
                <ArrowRight className="size-4" />
              )}
              {loading ? 'Создаём…' : 'Создать и войти'}
            </button>
          </form>
        )}

        {mode === 'connect' && (
          <form onSubmit={saveExistingRestaurantId} className="bg-card rounded-2xl border border-border p-6 space-y-4 shadow-sm">
            <p className="text-sm text-muted-foreground">
              База уже инициализирована. Введите <code className="font-mono text-foreground">restaurant_id</code>{' '}
              (UUID) от вашего ресторана. Найти его можно у владельца в настройках.
            </p>
            <input
              type="text"
              value={restId}
              onChange={e => setRestId(e.target.value)}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              className="w-full px-4 py-3 bg-background border border-input rounded-xl font-mono text-sm"
              autoFocus
            />
            <button
              type="submit"
              className="w-full flex items-center justify-center gap-2 bg-primary text-primary-foreground py-3.5 rounded-xl text-base font-semibold hover:bg-primary/90 transition-colors"
            >
              <ArrowRight className="size-4" />
              Сохранить и перейти на вход
            </button>
          </form>
        )}

        {mode === 'done' && (
          <div className="bg-card rounded-2xl border border-border p-8 flex flex-col items-center gap-3 shadow-sm">
            <CheckCircle2 className="size-14 text-primary" />
            <p className="text-lg font-semibold">Готово!</p>
            <p className="text-sm text-muted-foreground">Открываем dashboard…</p>
          </div>
        )}
      </div>
    </div>
  )
}
