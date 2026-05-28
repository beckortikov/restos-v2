'use client'

import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Bug, X, Send, Loader2 } from 'lucide-react'
import { sendBugReport } from '@/lib/bug-report'
import { toast } from 'sonner'

interface BugReportDialogProps {
  open: boolean
  onClose: () => void
}

export function BugReportDialog({ open, onClose }: BugReportDialogProps) {
  const [description, setDescription] = useState('')
  const [sending, setSending] = useState(false)

  if (!open) return null

  async function handleSend() {
    if (!description.trim()) return
    setSending(true)
    try {
      await sendBugReport(description)
      toast.success('Отчёт отправлен, спасибо!')
      setDescription('')
      onClose()
    } catch (err) {
      toast.error('Не удалось отправить отчёт')
      import('@sentry/react').then(Sentry => Sentry.captureException(err))
    } finally {
      setSending(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      {/* Dialog */}
      <div className="relative bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-2xl shadow-2xl w-full max-w-md">
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-200 dark:border-zinc-700">
          <div className="flex items-center gap-2">
            <Bug className="size-5 text-amber-600" />
            <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Сообщить об ошибке</h2>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors">
            <X className="size-4 text-zinc-400" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div>
            <label className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Что произошло?</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Опишите проблему: что вы делали, что пошло не так..."
              rows={4}
              autoFocus
              className="w-full mt-1.5 px-3 py-2 text-sm bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-500/30 resize-none text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400"
            />
          </div>

          <p className="text-xs text-zinc-500">
            Скриншот экрана и техническая информация будут отправлены автоматически.
          </p>

          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2.5 text-sm font-medium bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-colors text-zinc-700 dark:text-zinc-300"
            >
              Отмена
            </button>
            <button
              onClick={handleSend}
              disabled={sending || !description.trim()}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium bg-amber-600 text-white rounded-lg hover:bg-amber-700 transition-colors disabled:opacity-50"
            >
              {sending ? (
                <><Loader2 className="size-4 animate-spin" /> Отправляем...</>
              ) : (
                <><Send className="size-4" /> Отправить</>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
