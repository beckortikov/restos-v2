import { Component, type ReactNode, useState } from 'react'
import * as Sentry from '@sentry/react'
import { sendBugReport } from '@/lib/bug-report'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary] caught:', error, info.componentStack)

    // Stale chunk detection (after deploy, cached index.html has old chunk hashes).
    // Reload once per session to avoid infinite loop.
    const msg = String(error?.message || error || '')
    const isChunkError =
      msg.includes('Importing a module script failed') ||
      msg.includes('Failed to fetch dynamically imported module') ||
      (msg.includes('Loading chunk') && msg.includes('failed')) ||
      msg.includes('Unable to preload CSS')

    if (isChunkError) {
      // Time-based cooldown instead of one-shot flag, so later deploys in the
      // same session can still trigger a fresh reload.
      const RELOAD_KEY = 'restos-chunk-reload-ts'
      const COOLDOWN_MS = 30_000
      try {
        const last = Number(sessionStorage.getItem(RELOAD_KEY) || '0')
        if (Date.now() - last >= COOLDOWN_MS) {
          sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
          console.warn('[ErrorBoundary] stale bundle — reloading')
          const url = new URL(window.location.href)
          url.searchParams.set('_r', String(Date.now()))
          window.location.replace(url.toString())
          return
        }
      } catch { /* ignore storage errors */ }
    }

    Sentry.captureException(error, { extra: { componentStack: info.componentStack } })
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null })
    window.location.reload()
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-background p-6">
          <div className="max-w-md w-full text-center space-y-4">
            <div className="size-16 mx-auto rounded-full bg-red-100 flex items-center justify-center">
              <svg className="size-8 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
            </div>
            <h2 className="text-lg font-bold text-foreground">Произошла ошибка</h2>
            <p className="text-sm text-muted-foreground">
              {this.state.error?.message || 'Неизвестная ошибка'}
            </p>
            <div className="flex gap-3 justify-center pt-2">
              <button
                onClick={this.handleRetry}
                className="px-4 py-2.5 text-sm font-medium bg-card border border-border rounded-lg hover:bg-muted transition-colors"
              >
                Попробовать снова
              </button>
              <button
                onClick={this.handleReload}
                className="px-4 py-2.5 text-sm font-medium text-white bg-primary rounded-lg hover:bg-primary/90 transition-colors"
              >
                Перезагрузить
              </button>
            </div>
            <BugReportInline error={this.state.error} />
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

/** Inline bug report form shown inside ErrorBoundary */
function BugReportInline({ error }: { error: Error | null }) {
  const [description, setDescription] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)

  async function handleSend() {
    if (!description.trim()) return
    setSending(true)
    try {
      await sendBugReport(description, error ?? undefined)
      setSent(true)
    } catch {
      // silent — at least Sentry has it
    } finally {
      setSending(false)
    }
  }

  if (sent) {
    return (
      <div className="mt-4 p-3 bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-800 rounded-lg">
        <p className="text-sm text-emerald-700 dark:text-emerald-400 font-medium">Спасибо! Отчёт отправлен.</p>
      </div>
    )
  }

  return (
    <div className="mt-4 space-y-2">
      <p className="text-xs text-muted-foreground">Помогите нам — опишите что произошло:</p>
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Что вы делали перед ошибкой..."
        rows={2}
        className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
      />
      <button
        onClick={handleSend}
        disabled={sending || !description.trim()}
        className="w-full px-4 py-2 text-sm font-medium bg-amber-600 text-white rounded-lg hover:bg-amber-700 transition-colors disabled:opacity-50"
      >
        {sending ? 'Отправляем...' : 'Сообщить об ошибке'}
      </button>
    </div>
  )
}
