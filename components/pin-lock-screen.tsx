'use client'

import { useState, useEffect, useCallback } from 'react'
import { validatePin } from '@/lib/queries'
import { type User } from '@/lib/types'
import { LogOut, Delete } from 'lucide-react'

interface PinLockScreenProps {
  restaurantId: string
  restaurantName: string
  onUnlock: (user: User) => void
  onLogout: () => void
}

export function PinLockScreen({ restaurantId, restaurantName, onUnlock, onLogout }: PinLockScreenProps) {
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [shake, setShake] = useState(false)
  const [time, setTime] = useState('')

  // Clock
  useEffect(() => {
    const update = () => setTime(new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }))
    update()
    const id = setInterval(update, 30000)
    return () => clearInterval(id)
  }, [])

  const handleDigit = useCallback((digit: string) => {
    if (loading) return
    setError('')
    setPin(prev => {
      if (prev.length >= 4) return prev
      return prev + digit
    })
  }, [loading])

  const handleBackspace = useCallback(() => {
    if (loading) return
    setPin(prev => prev.slice(0, -1))
    setError('')
  }, [loading])

  const handleClear = useCallback(() => {
    if (loading) return
    setPin('')
    setError('')
  }, [loading])

  // Validate when 4 digits entered
  useEffect(() => {
    if (pin.length !== 4) return
    setLoading(true)
    validatePin(pin, restaurantId)
      .then(user => {
        if (user) {
          onUnlock(user)
        } else {
          setError('Неверный PIN-код')
          setShake(true)
          setTimeout(() => { setShake(false); setPin('') }, 600)
        }
      })
      .catch(() => {
        setError('Ошибка проверки')
        setShake(true)
        setTimeout(() => { setShake(false); setPin('') }, 600)
      })
      .finally(() => setLoading(false))
  }, [pin, restaurantId, onUnlock])

  // Keyboard input
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key >= '0' && e.key <= '9') handleDigit(e.key)
      else if (e.key === 'Backspace') handleBackspace()
      else if (e.key === 'Escape') handleClear()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleDigit, handleBackspace, handleClear])

  const dots = Array.from({ length: 4 }, (_, i) => i < pin.length)

  return (
    <div className="fixed inset-0 z-50 bg-[#0a0a0a] flex items-center justify-center select-none">
      <div className="w-full max-w-sm px-6 space-y-8">
        {/* Header */}
        <div className="text-center space-y-2">
          <p className="text-5xl font-light text-white/90">{time}</p>
          <p className="text-lg text-white/60">{restaurantName}</p>
          <p className="text-sm text-white/40">Введите PIN-код</p>
        </div>

        {/* PIN dots */}
        <div className={`flex items-center justify-center gap-4 py-4 ${shake ? 'animate-shake' : ''}`}>
          {dots.map((filled, i) => (
            <div
              key={i}
              className={`size-4 rounded-full transition-all duration-150 ${
                filled
                  ? error ? 'bg-red-500 scale-110' : 'bg-white scale-110'
                  : 'bg-white/20'
              }`}
            />
          ))}
        </div>

        {/* Error */}
        <div className="h-5 text-center">
          {error && <p className="text-sm text-red-400">{error}</p>}
          {loading && <p className="text-sm text-white/40">Проверка...</p>}
        </div>

        {/* Numpad */}
        <div className="grid grid-cols-3 gap-3">
          {['1','2','3','4','5','6','7','8','9'].map(d => (
            <button
              key={d}
              onClick={() => handleDigit(d)}
              className="h-16 rounded-2xl bg-white/10 text-white text-2xl font-medium hover:bg-white/20 active:bg-white/30 transition-colors"
            >
              {d}
            </button>
          ))}
          <button
            onClick={handleClear}
            className="h-16 rounded-2xl bg-white/5 text-white/40 text-sm font-medium hover:bg-white/10 transition-colors"
          >
            Очистить
          </button>
          <button
            onClick={() => handleDigit('0')}
            className="h-16 rounded-2xl bg-white/10 text-white text-2xl font-medium hover:bg-white/20 active:bg-white/30 transition-colors"
          >
            0
          </button>
          <button
            onClick={handleBackspace}
            className="h-16 rounded-2xl bg-white/5 text-white/40 hover:bg-white/10 transition-colors flex items-center justify-center"
          >
            <Delete className="size-6" />
          </button>
        </div>

        {/* Logout button */}
        <button
          onClick={onLogout}
          className="w-full flex items-center justify-center gap-2 py-3 text-sm text-white/30 hover:text-white/60 transition-colors"
        >
          <LogOut className="size-4" />
          Выйти из системы
        </button>
      </div>

      {/* Shake animation */}
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
