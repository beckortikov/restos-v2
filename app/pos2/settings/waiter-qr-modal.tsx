'use client'

import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { Smartphone, Wifi, AlertCircle, X } from 'lucide-react'

/**
 * WaiterQrModal — pos2-нативная версия /show-qr: QR для подключения официанта
 * к локальному серверу этой кассы, без ухода в классический интерфейс.
 * Логика (getLanIps + connect-URL, порт 3002) идентична app/(app)/show-qr.
 */
type IfaceIp = { iface: string; address: string }

export function WaiterQrModal({ onClose }: { onClose: () => void }) {
  const [lanIp, setLanIp] = useState('')
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [error, setError] = useState('')
  const [ips, setIps] = useState<IfaceIp[]>([])

  useEffect(() => {
    let cancel = false
    ;(async () => {
      try {
        const d = (window as any).restosDesktop
        let list: IfaceIp[] = []
        if (d?.getLanIps) list = await d.getLanIps()
        else if (d?.getLanIp) list = [{ iface: 'auto', address: await d.getLanIp() }]
        if (cancel) return
        if (!list || list.length === 0) list = [{ iface: 'fallback', address: '127.0.0.1' }]
        setIps(list)
        setLanIp(list[0].address)
      } catch (e) {
        if (!cancel) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => { cancel = true }
  }, [])

  useEffect(() => {
    if (!lanIp) return
    let cancel = false
    ;(async () => {
      try {
        const localUrl = `http://${lanIp}:3002`
        const connectUrl = `${localUrl}/connect?local=${encodeURIComponent(localUrl)}`
        const dataUrl = await QRCode.toDataURL(connectUrl, { width: 320, margin: 2, errorCorrectionLevel: 'M' })
        if (!cancel) setQrDataUrl(dataUrl)
      } catch (e) {
        if (!cancel) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => { cancel = true }
  }, [lanIp])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(26,26,26,0.5)' }} onClick={onClose}>
      <div
        className="rounded-2xl w-full max-w-md flex flex-col"
        style={{ background: 'var(--pv-card)', border: '1px solid var(--pv-border)', padding: 'clamp(1.1rem,1.8vw,1.6rem)', gap: '1rem', maxHeight: '92vh', overflowY: 'auto' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-3">
          <div className="rounded-xl flex items-center justify-center shrink-0" style={{ background: 'var(--pv-bg)', width: '2.6rem', height: '2.6rem' }}>
            <Smartphone style={{ width: '1.3rem', height: '1.3rem', color: 'var(--pv-brand)' }} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.05rem,1.4vw,1.25rem)' }}>Подключить официанта</div>
            <div style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.1rem)' }}>Отсканируйте QR с телефона официанта</div>
          </div>
          <button onClick={onClose} className="rounded-lg flex items-center justify-center shrink-0 active:scale-95 transition-transform" style={{ background: 'var(--pv-bg)', width: '2.1rem', height: '2.1rem' }}>
            <X style={{ width: '1.1rem', height: '1.1rem', color: 'var(--pv-text-2)' }} />
          </button>
        </div>

        {error ? (
          <div className="flex items-start gap-2 rounded-lg" style={{ background: 'var(--pv-occ-soft)', color: 'var(--pv-occ-text)', padding: '0.6rem 0.75rem', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>
            <AlertCircle style={{ width: '1rem', height: '1rem', flexShrink: 0, marginTop: '0.1rem' }} />
            <span>Не удалось сгенерировать QR: {error}</span>
          </div>
        ) : qrDataUrl ? (
          <div className="flex justify-center">
            <div style={{ background: '#fff', padding: '1rem', borderRadius: '0.9rem', border: '1px solid var(--pv-border)' }}>
              <img src={qrDataUrl} alt="QR" style={{ width: '15rem', height: '15rem', display: 'block' }} />
            </div>
          </div>
        ) : (
          <div className="flex justify-center" style={{ padding: '3rem 0' }}>
            <div className="animate-spin" style={{ width: '2rem', height: '2rem', border: '4px solid var(--pv-border)', borderTopColor: 'var(--pv-brand)', borderRadius: '9999px' }} />
          </div>
        )}

        {lanIp && (
          <div className="flex items-center gap-2 rounded-lg" style={{ background: 'var(--pv-bg)', color: 'var(--pv-text-2)', padding: '0.6rem 0.75rem', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>
            <Wifi style={{ width: '1rem', height: '1rem', flexShrink: 0 }} />
            <span>Сеть: <code style={{ fontFamily: 'monospace', color: 'var(--pv-text)' }}>{lanIp}:3002</code></span>
          </div>
        )}

        {ips.length > 1 && (
          <div className="flex flex-col" style={{ gap: '0.4rem', borderTop: '1px solid var(--pv-border)', paddingTop: '0.75rem' }}>
            <div style={{ color: 'var(--pv-text-2)', fontSize: 'calc(var(--pv-ctl) - 0.1rem)', fontWeight: 600 }}>У кассы несколько WiFi — выберите ту, к которой подключён телефон:</div>
            {ips.map(i => {
              const on = lanIp === i.address
              return (
                <button key={i.address} onClick={() => setLanIp(i.address)} className="flex items-center justify-between gap-2 rounded-lg active:scale-[0.98] transition-transform" style={{ border: `1px solid ${on ? 'var(--pv-brand)' : 'var(--pv-border)'}`, background: on ? 'var(--pv-brand-soft, var(--pv-bg))' : 'transparent', color: on ? 'var(--pv-text)' : 'var(--pv-text-2)', padding: '0.5rem 0.7rem', fontSize: 'calc(var(--pv-ctl) - 0.1rem)' }}>
                  <span style={{ fontFamily: 'monospace' }}>{i.address}</span>
                  <span style={{ opacity: 0.6, fontSize: 'calc(var(--pv-ctl) - 0.2rem)' }} className="truncate">{i.iface}</span>
                </button>
              )
            })}
          </div>
        )}

        <div className="flex flex-col" style={{ gap: '0.35rem', borderTop: '1px solid var(--pv-border)', paddingTop: '0.75rem', color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.1rem)' }}>
          <div style={{ color: 'var(--pv-text-2)', fontWeight: 600 }}>Как подключить:</div>
          <ol style={{ listStyle: 'decimal', paddingLeft: '1.1rem', display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
            <li>Телефон официанта — в той же WiFi-сети</li>
            <li>Откройте камеру или сканер QR</li>
            <li>Наведите на QR-код выше</li>
            <li>Тапните по ссылке → откроется браузер</li>
            <li>Установите приложение и войдите по PIN</li>
          </ol>
        </div>
      </div>
    </div>
  )
}
