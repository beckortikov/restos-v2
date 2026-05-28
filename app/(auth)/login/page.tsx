'use client'

import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { UtensilsCrossed, Delete, LogIn, AlertCircle, Settings2 } from 'lucide-react'
import { useAuth } from '@/lib/auth-store'
import { api, unwrap, getV4RestaurantId } from '@/lib/api'

export default function LoginPage() {
  const [loading, setLoading] = useState(false)
  const [bootstrapChecked, setBootstrapChecked] = useState(false)
  const [error, setError] = useState('')
  const [pin, setPin] = useState('')
  const { login, user, homeRoute } = useAuth()
  const navigate = useNavigate()

  // Redirect to /bootstrap if backend has no restaurants yet.
  useEffect(() => {
    let cancel = false
    ;(async () => {
      try {
        const status: any = await unwrap(api.GET('/api/v1/bootstrap/status'))
        if (cancel) return
        if (!status.initialized) {
          navigate('/bootstrap', { replace: true })
          return
        }
        if (!getV4RestaurantId()) {
          // Бэк инициализирован, но клиент не знает restaurant_id.
          // Это типично при первом подключении ноут-кассы к существующему бэку.
          navigate('/bootstrap', { replace: true })
          return
        }
      } catch (e) {
        // backend недоступен — оставим форму, но не блокируем.
        console.warn('bootstrap status check failed', e)
      } finally {
        if (!cancel) setBootstrapChecked(true)
      }
    })()
    return () => { cancel = true }
  }, [navigate])

  // If already logged in, redirect home.
  useEffect(() => {
    if (user) navigate(homeRoute, { replace: true })
  }, [user, navigate, homeRoute])

  async function submitPin(value: string) {
    if (value.length < 4) {
      setError('PIN не может быть короче 4 цифр')
      return
    }
    setLoading(true)
    setError('')
    const result = await login(value)
    if (result.ok) {
      navigate(homeRoute, { replace: true })
    } else {
      setError(result.error || 'Ошибка входа')
      setPin('')
      setLoading(false)
    }
  }

  function pushDigit(d: string) {
    if (loading) return
    if (pin.length >= 8) return
    const next = pin + d
    setPin(next)
    setError('')
    if (next.length >= 4 && next.length === 4) {
      // авто-submit на 4-значном PIN, если ничего больше не вводится
      setTimeout(() => {
        // даём шанс пользователю продолжить ввод длиннее
      }, 300)
    }
  }

  function popDigit() {
    if (loading) return
    setPin(p => p.slice(0, -1))
  }

  function clearPin() {
    if (loading) return
    setPin('')
    setError('')
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex flex-col items-center mb-6">
          <div className="size-14 rounded-2xl bg-primary flex items-center justify-center mb-4">
            <UtensilsCrossed className="size-7 text-primary-foreground" />
          </div>
          <h1 className="text-2xl font-bold text-foreground">RestOS</h1>
          <p className="text-muted-foreground text-sm mt-1">Введите ваш PIN-код</p>
        </div>

        {!bootstrapChecked ? (
          <div className="flex items-center justify-center py-12">
            <div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
          </div>
        ) : (
          <div className="bg-card rounded-2xl border border-border p-6 space-y-4 shadow-sm">
            {error && (
              <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 px-3 py-2.5 rounded-lg">
                <AlertCircle className="size-4 shrink-0" />
                {error}
              </div>
            )}

            {/* PIN display */}
            <div className="flex items-center justify-center gap-2 py-2">
              {Array.from({ length: Math.max(4, pin.length) }, (_, i) => (
                <div
                  key={i}
                  className={`size-4 rounded-full border-2 ${i < pin.length ? 'bg-primary border-primary' : 'border-muted-foreground/30'}`}
                />
              ))}
            </div>

            {/* Number pad */}
            <div className="grid grid-cols-3 gap-2">
              {['1','2','3','4','5','6','7','8','9'].map(d => (
                <button
                  key={d}
                  type="button"
                  onClick={() => pushDigit(d)}
                  disabled={loading}
                  className="py-4 text-xl font-semibold rounded-xl bg-muted hover:bg-muted/80 active:scale-95 transition-all disabled:opacity-50"
                >
                  {d}
                </button>
              ))}
              <button
                type="button"
                onClick={clearPin}
                disabled={loading}
                className="py-4 text-sm rounded-xl bg-muted hover:bg-muted/80 active:scale-95 transition-all disabled:opacity-50"
              >
                Очистить
              </button>
              <button
                type="button"
                onClick={() => pushDigit('0')}
                disabled={loading}
                className="py-4 text-xl font-semibold rounded-xl bg-muted hover:bg-muted/80 active:scale-95 transition-all disabled:opacity-50"
              >
                0
              </button>
              <button
                type="button"
                onClick={popDigit}
                disabled={loading}
                className="py-4 flex items-center justify-center rounded-xl bg-muted hover:bg-muted/80 active:scale-95 transition-all disabled:opacity-50"
              >
                <Delete className="size-5" />
              </button>
            </div>

            <button
              type="button"
              onClick={() => submitPin(pin)}
              disabled={loading || pin.length < 4}
              className="w-full flex items-center justify-center gap-2 bg-primary text-primary-foreground py-3.5 rounded-xl text-base font-semibold hover:bg-primary/90 disabled:opacity-60 transition-colors"
            >
              {loading ? (
                <div className="size-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
              ) : (
                <LogIn className="size-4" />
              )}
              {loading ? 'Вход…' : 'Войти'}
            </button>

            <button
              type="button"
              onClick={() => navigate('/bootstrap')}
              className="w-full flex items-center justify-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors pt-2"
            >
              <Settings2 className="size-4" />
              Сменить ресторан / переинициализация
            </button>
          </div>
        )}

        <p className="text-center text-xs text-muted-foreground mt-4">
          RestOS v{typeof window !== 'undefined' && (window as any).restosDesktop?.version || '4.0'}
        </p>
      </div>
    </div>
  )
}
