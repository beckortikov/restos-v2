'use client'

import { useState, useEffect } from 'react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { createReservation } from '@/lib/queries'
import { useAuth } from '@/lib/auth-store'
import { CalendarClock, Users, Phone, User, MessageSquare } from 'lucide-react'
import { toast } from 'sonner'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  tableId: string
  tableName: string
  tableCapacity: number
  onSuccess: () => void
}

export function ReservationDialog({ open, onOpenChange, tableId, tableName, tableCapacity, onSuccess }: Props) {
  const { user } = useAuth()
  const [guestName, setGuestName] = useState('')
  const [guestPhone, setGuestPhone] = useState('')
  const [guestsCount, setGuestsCount] = useState(tableCapacity || 2)
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [durationMin, setDurationMin] = useState(120)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setGuestName('')
      setGuestPhone('')
      setGuestsCount(2)
      // Default: today, next round hour
      const now = new Date()
      now.setHours(now.getHours() + 1, 0, 0, 0)
      setDate(now.toISOString().slice(0, 10))
      setTime(now.toTimeString().slice(0, 5))
      setDurationMin(120)
      setNote('')
    }
  }, [open])

  const canSubmit = guestName.trim() && date && time && guestsCount > 0

  const handleSubmit = async () => {
    if (!canSubmit) return
    setSaving(true)
    try {
      const reservedAt = new Date(`${date}T${time}:00`).toISOString()
      await createReservation({
        tableId,
        guestName: guestName.trim(),
        guestPhone: guestPhone.trim() || undefined,
        guestsCount,
        reservedAt,
        durationMin,
        note: note.trim() || undefined,
        createdBy: user?.id,
      })
      toast.success(`Бронь оформлена: ${guestName.trim()}`)
      onOpenChange(false)
      onSuccess()
    } catch (e) {
      console.error(e)
      toast.error('Ошибка бронирования')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto rounded-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarClock className="size-5 text-primary" />
            Бронирование — {tableName}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Guest name */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground flex items-center gap-1.5">
              <User className="size-3.5" />Имя гостя <span className="text-destructive">*</span>
            </label>
            <input
              value={guestName}
              onChange={e => setGuestName(e.target.value)}
              placeholder="Иванов Иван"
              className="w-full px-3 py-2.5 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          {/* Phone */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground flex items-center gap-1.5">
              <Phone className="size-3.5" />Телефон
            </label>
            <input
              type="tel"
              value={guestPhone}
              onChange={e => setGuestPhone(e.target.value.replace(/[^\d+\-\s()]/g, ''))}
              inputMode="tel"
              placeholder="+992 900 000000"
              className="w-full px-3 py-2.5 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          {/* Guests count */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground flex items-center gap-1.5">
              <Users className="size-3.5" />Количество гостей <span className="text-destructive">*</span>
            </label>
            <div className="flex items-center gap-3">
              <input
                type="number"
                min={1}
                max={tableCapacity * 2}
                value={guestsCount}
                onChange={e => setGuestsCount(Number(e.target.value))}
                className="w-24 px-3 py-2.5 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
              <span className="text-xs text-muted-foreground">вместимость стола: {tableCapacity}</span>
              {guestsCount > tableCapacity && (
                <span className="text-xs text-amber-600 font-medium">Превышена!</span>
              )}
            </div>
          </div>

          {/* Date & Time */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Дата <span className="text-destructive">*</span></label>
              <input
                type="date"
                value={date}
                onChange={e => setDate(e.target.value)}
                min={new Date().toISOString().slice(0, 10)}
                className="w-full px-3 py-2.5 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Время <span className="text-destructive">*</span></label>
              <input
                type="time"
                value={time}
                onChange={e => setTime(e.target.value)}
                className="w-full px-3 py-2.5 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
          </div>

          {/* Duration */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Длительность</label>
            <div className="flex gap-1.5">
              {[60, 90, 120, 180].map(mins => (
                <button
                  key={mins}
                  type="button"
                  onClick={() => setDurationMin(mins)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                    durationMin === mins
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-card border-border text-foreground hover:bg-muted'
                  }`}
                >
                  {mins >= 60 ? `${mins / 60}ч` : `${mins}м`}
                </button>
              ))}
            </div>
          </div>

          {/* Note */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground flex items-center gap-1.5">
              <MessageSquare className="size-3.5" />Комментарий
            </label>
            <input
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="День рождения, аллергии, пожелания..."
              className="w-full px-3 py-2.5 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
        </div>

        <DialogFooter>
          <button onClick={() => onOpenChange(false)}
            className="px-4 py-2.5 text-sm font-medium text-foreground bg-card border border-border rounded-lg hover:bg-muted transition-colors">
            Отмена
          </button>
          <button onClick={handleSubmit} disabled={!canSubmit || saving}
            className="px-5 py-2.5 text-sm font-medium text-primary-foreground bg-primary rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50">
            {saving ? 'Бронирование...' : 'Забронировать'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
