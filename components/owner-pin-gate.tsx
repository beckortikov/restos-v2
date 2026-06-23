'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { validatePin } from '@/lib/queries'
import { ShieldCheck, Delete, ArrowLeft } from 'lucide-react'

interface OwnerPinGateProps {
  restaurantId: string
  /** Заголовок раздела, который защищаем (например «Смены»). */
  sectionLabel: string
  /** Вызывается при успешной проверке ПИН владельца. */
  onSuccess: () => void
  /** Кнопка «Назад» — уводит из защищённого раздела. */
  onBack: () => void
}

/**
 * Полноэкранный гейт «введите ПИН владельца», чтобы открыть защищённый раздел.
 * Принимает только ПИН пользователя с ролью `owner`. Логика ввода (4–8 цифр,
 * авто-проверка после паузы) повторяет экран логина.
 */
export function OwnerPinGate({ restaurantId, sectionLabel, onSuccess, onBack }: OwnerPinGateProps) {
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [shake, setShake] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const submit = useCallback(async (value: string) => {
    if (value.length < 4) return
    setLoading(true)
    setError('')
    try {
      const u = await validatePin(value, restaurantId)
      if (u && u.role === 'owner') {
        onSuccess()
        return
      }
      setError(u ? 'Нужен ПИН владельца' : 'Неверный ПИН')
    } catch {
      setError('Ошибка проверки')
    }
    setShake(true)
    setLoading(false)
    setTimeout(() => { setShake(false); setPin('') }, 600)
  }, [restaurantId, onSuccess])

  const handleDigit = useCallback((d: string) => {
    if (loading) return
    setError('')
    setPin(prev => (prev.length >= 8 ? prev : prev + d))
  }, [loading])

  const handleBackspace = useCallback(() => {
    if (loading) return
    setError('')
    setPin(prev => prev.slice(0, -1))
  }, [loading])

  const handleClear = useCallback(() => {
    if (loading) return
    setError('')
    setPin('')
  }, [loading])

  // Дебаунс авто-проверки: 600ms после 4-й цифры (даём шанс ввести 5–8), 300ms дальше.
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (pin.length < 4) return
    const delay = pin.length === 4 ? 600 : 300
    timerRef.current = setTimeout(() => submit(pin), delay)
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [pin, submit])

  // Клавиатура.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key >= '0' && e.key <= '9') handleDigit(e.key)
      else if (e.key === 'Backspace') handleBackspace()
      else if (e.key === 'Escape') handleClear()
      else if (e.key === 'Enter') submit(pin)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleDigit, handleBackspace, handleClear, submit, pin])

  return (
    <div className="h-full flex items-center justify-center p-6">
      <div className="w-full max-w-xs space-y-6">
        <div className="text-center space-y-2">
          <div className="size-14 mx-auto rounded-2xl bg-primary/10 flex items-center justify-center">
            <ShieldCheck className="size-7 text-primary" />
          </div>
          <h1 className="text-lg font-bold text-foreground">Раздел «{sectionLabel}»</h1>
          <p className="text-sm text-muted-foreground">Введите ПИН владельца для доступа</p>
        </div>

        <div className={`flex items-center justify-center gap-3 py-2 ${shake ? 'animate-shake' : ''}`}>
          {Array.from({ length: Math.max(4, pin.length) }, (_, i) => (
            <div
              key={i}
              className={`size-3.5 rounded-full border-2 ${i < pin.length ? (error ? 'bg-destructive border-destructive' : 'bg-primary border-primary') : 'border-muted-foreground/30'}`}
            />
          ))}
        </div>

        <div className="h-5 text-center">
          {error && <p className="text-sm text-destructive">{error}</p>}
          {loading && !error && <p className="text-sm text-muted-foreground">Проверка…</p>}
        </div>

        <div className="grid grid-cols-3 gap-3">
          {['1','2','3','4','5','6','7','8','9'].map(d => (
            <button key={d} onClick={() => handleDigit(d)} disabled={loading}
              className="py-4 text-xl font-semibold rounded-xl bg-muted hover:bg-muted/80 active:scale-95 transition-all disabled:opacity-50">{d}</button>
          ))}
          <button onClick={handleClear} disabled={loading}
            className="py-4 text-sm rounded-xl bg-muted hover:bg-muted/80 active:scale-95 transition-all disabled:opacity-50">Очистить</button>
          <button onClick={() => handleDigit('0')} disabled={loading}
            className="py-4 text-xl font-semibold rounded-xl bg-muted hover:bg-muted/80 active:scale-95 transition-all disabled:opacity-50">0</button>
          <button onClick={handleBackspace} disabled={loading}
            className="py-4 flex items-center justify-center rounded-xl bg-muted hover:bg-muted/80 active:scale-95 transition-all disabled:opacity-50"><Delete className="size-6" /></button>
        </div>

        <button onClick={onBack}
          className="w-full flex items-center justify-center gap-2 py-3 text-sm text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="size-4" />Назад
        </button>
      </div>

      <style>{`
        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          20% { transform: translateX(-12px); }
          40% { transform: translateX(12px); }
          60% { transform: translateX(-8px); }
          80% { transform: translateX(8px); }
        }
        .animate-shake { animation: shake 0.4s ease-in-out; }
      `}</style>
    </div>
  )
}
