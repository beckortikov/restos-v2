'use client'

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import QRCode from 'qrcode'
import { ArrowLeft, Smartphone, Wifi, AlertCircle } from 'lucide-react'

/**
 * /show-qr — экран для КАССИРА с QR-кодом, который сканирует официант своим
 * телефоном чтобы подключиться к локальному серверу этой кассы.
 *
 * QR содержит URL вида:
 *    http://<LAN_IP>:3001/connect?local=http://<LAN_IP>:3001
 *
 * Официант: открывает URL → /connect страница ловит ?local=, сохраняет в
 * localStorage его телефона → редирект на /login для PIN ввода.
 */
export default function ShowQrPage() {
  const navigate = useNavigate()
  const [lanIp, setLanIp] = useState<string>('')
  const [qrDataUrl, setQrDataUrl] = useState<string>('')
  const [error, setError] = useState<string>('')

  useEffect(() => {
    let cancel = false
    ;(async () => {
      try {
        const d = (window as { restosDesktop?: { getLanIp?: () => Promise<string> } }).restosDesktop
        let ip = '127.0.0.1'
        if (d?.getLanIp) {
          ip = await d.getLanIp()
        }
        if (cancel) return
        setLanIp(ip)

        const port = 3001
        const localUrl = `http://${ip}:${port}`
        const connectUrl = `${localUrl}/connect?local=${encodeURIComponent(localUrl)}`
        const dataUrl = await QRCode.toDataURL(connectUrl, {
          width: 320,
          margin: 2,
          errorCorrectionLevel: 'M',
        })
        if (!cancel) setQrDataUrl(dataUrl)
      } catch (e) {
        if (cancel) return
        setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => { cancel = true }
  }, [])

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background p-6">
      <div className="max-w-md w-full space-y-6">
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="size-4" />
          Назад
        </button>

        <div className="bg-card rounded-2xl border border-border p-6 space-y-5 shadow-sm">
          <div className="flex flex-col items-center gap-2">
            <div className="size-12 rounded-2xl bg-primary/10 flex items-center justify-center">
              <Smartphone className="size-6 text-primary" />
            </div>
            <h1 className="text-xl font-bold text-center">Подключить официанта</h1>
            <p className="text-sm text-muted-foreground text-center">
              Отсканируйте QR-код с телефона официанта чтобы привязать его к этой кассе
            </p>
          </div>

          {error ? (
            <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 px-3 py-2.5 rounded-lg">
              <AlertCircle className="size-4 shrink-0 mt-0.5" />
              <span>Не удалось сгенерировать QR: {error}</span>
            </div>
          ) : qrDataUrl ? (
            <div className="flex justify-center">
              <div className="bg-white p-4 rounded-xl border border-border">
                <img src={qrDataUrl} alt="QR" className="size-64" />
              </div>
            </div>
          ) : (
            <div className="flex justify-center py-16">
              <div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
            </div>
          )}

          {lanIp && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted/40 px-3 py-2.5 rounded-lg">
              <Wifi className="size-4 shrink-0" />
              <span>
                Сеть: <code className="font-mono text-foreground">{lanIp}:3001</code>
              </span>
            </div>
          )}

          <div className="space-y-2 text-xs text-muted-foreground border-t border-border pt-4">
            <p className="font-medium text-foreground">Как подключить:</p>
            <ol className="list-decimal pl-4 space-y-1">
              <li>Убедитесь что телефон официанта в той же WiFi-сети</li>
              <li>Откройте камеру или сканер QR на телефоне</li>
              <li>Наведите на QR-код выше</li>
              <li>Тапните по ссылке → откроется браузер</li>
              <li>Установите PWA и войдите по PIN официанта</li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  )
}
