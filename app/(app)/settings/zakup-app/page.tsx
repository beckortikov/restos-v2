'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { toast } from 'sonner'
import { ShoppingBasket, Upload, Wifi, AlertCircle, Download, RefreshCw } from 'lucide-react'

import { getBaseURL } from '@/lib/api'
import { randomId } from '@/lib/random-id'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

const PORT = 3002 // бэк кассы слушает 0.0.0.0:3002 (см. config.go)

type AppDistInfo = {
  available: boolean
  version: string
  file_name: string
  size_bytes: number
  uploaded_at: string | null
  download_path: string
}
type IfaceIp = { iface: string; address: string }

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = localStorage.getItem('restos-v4-token')
  const h: Record<string, string> = { ...extra }
  if (token) h['Authorization'] = `Bearer ${token}`
  return h
}

function fmtBytes(n: number): string {
  if (!n) return '—'
  const mb = n / (1024 * 1024)
  return mb >= 1 ? `${mb.toFixed(1)} МБ` : `${Math.round(n / 1024)} КБ`
}

export default function ZakupAppPage() {
  const [info, setInfo] = useState<AppDistInfo | null>(null)
  const [ips, setIps] = useState<IfaceIp[]>([])
  const [lanIp, setLanIp] = useState('')
  const [qr, setQr] = useState('')
  const [uploading, setUploading] = useState(false)
  const [loading, setLoading] = useState(true)
  const fileRef = useRef<HTMLInputElement>(null)

  const loadInfo = useCallback(async () => {
    try {
      const res = await fetch(getBaseURL() + '/api/v1/zakup-app', { headers: authHeaders() })
      if (!res.ok) throw new Error(await res.text())
      setInfo(await res.json())
    } catch (e) {
      toast.error('Не удалось загрузить состояние APK: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setLoading(false)
    }
  }, [])

  // LAN-IP кассы (как в /show-qr): Electron отдаёт через preload getLanIps.
  useEffect(() => {
    loadInfo()
    ;(async () => {
      try {
        const d = (window as any).restosDesktop
        let list: IfaceIp[] = []
        if (d?.getLanIps) list = await d.getLanIps()
        else if (d?.getLanIp) list = [{ iface: 'auto', address: await d.getLanIp() }]
        // Браузер по LAN (не Electron) → берём хост из адресной строки.
        if ((!list || list.length === 0) && typeof window !== 'undefined') {
          const h = window.location.hostname
          if (h && h !== 'localhost' && h !== '127.0.0.1') list = [{ iface: 'browser', address: h }]
        }
        if (!list || list.length === 0) list = [{ iface: 'fallback', address: '127.0.0.1' }]
        setIps(list)
        setLanIp(list[0].address)
      } catch {
        setIps([{ iface: 'fallback', address: '127.0.0.1' }])
        setLanIp('127.0.0.1')
      }
    })()
  }, [loadInfo])

  const downloadUrl = lanIp ? `http://${lanIp}:${PORT}/download/zakup.apk` : ''

  // QR на ссылку скачивания (только если APK загружен).
  useEffect(() => {
    if (!downloadUrl || !info?.available) { setQr(''); return }
    let cancel = false
    QRCode.toDataURL(downloadUrl, { width: 320, margin: 2, errorCorrectionLevel: 'M' })
      .then((u) => { if (!cancel) setQr(u) })
      .catch(() => { if (!cancel) setQr('') })
    return () => { cancel = true }
  }, [downloadUrl, info?.available])

  async function handleUpload(file: File) {
    if (!file.name.toLowerCase().endsWith('.apk')) {
      toast.error('Нужен файл .apk')
      return
    }
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch(getBaseURL() + '/api/v1/zakup-app', {
        method: 'POST',
        headers: authHeaders({ 'Idempotency-Key': randomId() }),
        body: fd,
      })
      if (!res.ok) throw new Error(await res.text())
      setInfo(await res.json())
      toast.success('APK загружен — закупщик может обновиться по QR')
    } catch (e) {
      toast.error('Ошибка загрузки: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-bold">Приложение закупщика</h1>
        <p className="text-sm text-muted-foreground">
          Раздача APK по локальной WiFi: закупщик сканирует QR телефоном и скачивает приложение.
        </p>
      </div>

      {/* Загрузка APK */}
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-medium">Текущий APK</div>
              {loading ? (
                <div className="text-sm text-muted-foreground">Загрузка…</div>
              ) : info?.available ? (
                <div className="text-sm text-muted-foreground">
                  {info.version ? `Версия ${info.version} · ` : ''}{fmtBytes(info.size_bytes)}
                  {info.uploaded_at ? ` · ${new Date(info.uploaded_at).toLocaleString('ru-RU')}` : ''}
                </div>
              ) : (
                <div className="text-sm text-amber-600 dark:text-amber-400">
                  APK ещё не загружен — загрузите .apk, чтобы появился QR.
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={loadInfo} disabled={loading}>
                <RefreshCw className="mr-2 h-4 w-4" /> Обновить
              </Button>
              <Button size="sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
                <Upload className="mr-2 h-4 w-4" /> {uploading ? 'Загрузка…' : 'Загрузить APK'}
              </Button>
            </div>
          </div>
          <input
            ref={fileRef} type="file" accept=".apk,application/vnd.android.package-archive"
            className="hidden"
            onChange={(e) => { const file = e.target.files?.[0]; if (file) handleUpload(file) }}
          />
        </CardContent>
      </Card>

      {/* QR + ссылка */}
      {info?.available && (
        <Card>
          <CardContent className="space-y-4 p-4">
            <div className="flex flex-col items-center gap-3">
              <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/10">
                <ShoppingBasket className="size-6 text-primary" />
              </div>
              <div className="text-center">
                <div className="font-semibold">Скачать на телефон закупщика</div>
                <p className="text-sm text-muted-foreground">Телефон должен быть в той же WiFi-сети, что и касса</p>
              </div>
              {qr ? (
                <div className="rounded-xl border border-border bg-white p-4">
                  <img src={qr} alt="QR на скачивание APK" className="size-60" />
                </div>
              ) : (
                <div className="flex h-60 items-center justify-center text-sm text-muted-foreground">
                  Генерация QR…
                </div>
              )}
              {downloadUrl && (
                <div className="flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                  <Wifi className="size-4 shrink-0" />
                  <code className="font-mono text-foreground break-all">{downloadUrl}</code>
                </div>
              )}
              <a href={downloadUrl} className="text-sm text-primary hover:underline" target="_blank" rel="noreferrer">
                <Download className="mr-1 inline h-4 w-4" /> Открыть ссылку
              </a>
            </div>

            {ips.length > 1 && (
              <div className="space-y-1.5 border-t border-border pt-3">
                <p className="text-xs font-medium">Несколько сетей — выберите ту, к которой подключён телефон:</p>
                <div className="flex flex-col gap-1.5">
                  {ips.map((i) => (
                    <button
                      key={i.address} onClick={() => setLanIp(i.address)}
                      className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs transition-colors ${
                        lanIp === i.address ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted text-muted-foreground'
                      }`}
                    >
                      <span className="font-mono">{i.address}</span>
                      <span className="truncate text-[10px] opacity-60">{i.iface}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
              <p className="font-medium text-foreground">Как обновить приложение у закупщика:</p>
              <ol className="list-decimal space-y-0.5 pl-4">
                <li>Соберите новый APK и нажмите «Загрузить APK» здесь.</li>
                <li>Закупщик сканирует QR камерой телефона.</li>
                <li>Браузер скачает .apk → установка (Android спросит разрешение один раз).</li>
              </ol>
            </div>
          </CardContent>
        </Card>
      )}

      {!info?.available && !loading && (
        <div className="flex items-start gap-2 rounded-lg bg-muted/40 px-3 py-2.5 text-sm text-muted-foreground">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>После загрузки APK здесь появится QR-код для раздачи закупщику.</span>
        </div>
      )}
    </div>
  )
}
