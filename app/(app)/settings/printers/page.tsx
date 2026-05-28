'use client'

import { useState, useEffect } from 'react'
import { useAuth } from '@/lib/auth-store'
import { ALL_STATIONS, STATION_LABELS, STATION_ICONS, type MenuStation } from '@/lib/types'
import {
  type StationPrinter,
  type ReceiptPrinter,
  getStationPrinters, saveStationPrinters,
  getReceiptPrinter, saveReceiptPrinter,
  getPrintServerUrl, isPrintServerAvailable,
} from '@/lib/print-service'
import { Printer, Save, CheckCircle2, TestTube, Wifi, WifiOff, RefreshCw, Receipt, ListOrdered } from 'lucide-react'
import { toast } from 'sonner'
import { Link } from 'react-router-dom'

export default function PrinterSettingsPage() {
  const { canDo } = useAuth()
  const [printers, setPrinters] = useState<StationPrinter[]>([])
  const [receiptPrinter, setReceiptPrinterState] = useState<ReceiptPrinter>({ printerName: '', printerIP: '', enabled: false })
  const [serverStatus, setServerStatus] = useState<'checking' | 'online' | 'offline'>('checking')

  const isDesktop = typeof window !== 'undefined' && !!(window as any).restosDesktop?.isDesktop

  useEffect(() => {
    const saved = getStationPrinters()
    const full = ALL_STATIONS.map(station => {
      const existing = saved.find(p => p.station === station)
      return existing || { station, printerName: '', printerIP: '', enabled: false }
    })
    setPrinters(full)
    const rcpt = getReceiptPrinter()
    if (rcpt) setReceiptPrinterState(rcpt)
    checkServer()
  }, [])

  const checkServer = async () => {
    setServerStatus('checking')
    const ok = await isPrintServerAvailable()
    setServerStatus(ok ? 'online' : 'offline')
  }

  const updatePrinter = (station: MenuStation, field: Partial<StationPrinter>) => {
    setPrinters(prev => prev.map(p => p.station === station ? { ...p, ...field } : p))
  }

  const handleSave = () => {
    saveStationPrinters(printers)
    saveReceiptPrinter(receiptPrinter.printerIP || receiptPrinter.printerName ? receiptPrinter : null)
    toast.success('Настройки принтеров сохранены')
  }

  const handleTestReceipt = async () => {
    const target = receiptPrinter.printerIP || receiptPrinter.printerName
    if (!target) {
      toast.error('Принтер кассы не настроен')
      return
    }
    try {
      const res = await fetch(`${getPrintServerUrl()}/print`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          printerIP: target,
          data: '1B401C2E1B7411' +
            '1B6101' + '1B4501' + '1D2111' +
            Array.from(new TextEncoder().encode('ТЕСТ ЧЕКА')).map(b => b.toString(16).padStart(2, '0')).join('') +
            '0A' + '1D2100' + '1B4500' +
            Array.from(new TextEncoder().encode('Принтер кассы')).map(b => b.toString(16).padStart(2, '0')).join('') +
            '0A0A' + '1D564203'
        }),
      })
      if (res.ok) toast.success(`Тест отправлен на ${target}`)
      else toast.error('Ошибка печати')
    } catch {
      toast.error('Принт-сервер не доступен')
    }
  }

  const handleTestPrint = async (station: MenuStation) => {
    const printer = printers.find(p => p.station === station)
    const target = printer?.printerIP || printer?.printerName
    if (!target) {
      toast.error('Принтер не настроен')
      return
    }
    try {
      const res = await fetch(`${getPrintServerUrl()}/print`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          printerIP: target,
          data: '1B401C2E1B7411' + // Reset + disable Chinese + CP866
            '1B6101' + '1B4501' + '1D2111' + // Center + Bold + Double size
            Array.from(new TextEncoder().encode('ТЕСТ')).map(b => b.toString(16).padStart(2, '0')).join('') +
            '0A' + '1D2100' + '1B4500' + // Newline + Normal
            Array.from(new TextEncoder().encode(STATION_LABELS[station])).map(b => b.toString(16).padStart(2, '0')).join('') +
            '0A0A' +
            Array.from(new TextEncoder().encode('RestOS Desktop')).map(b => b.toString(16).padStart(2, '0')).join('') +
            '0A' +
            '1D564203' // Cut
        }),
      })
      if (res.ok) toast.success(`Тест отправлен на ${target}`)
      else toast.error('Ошибка печати — проверьте IP и что принтер включён')
    } catch {
      toast.error('Принт-сервер не доступен. Запущен ли RestOS на этом ПК?')
    }
  }

  if (!canDo('printers.manage')) {
    return <div className="p-6 flex items-center justify-center h-64"><p className="text-muted-foreground">Нет доступа</p></div>
  }

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-2xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">Настройка принтеров</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Привязка термопринтеров к станциям приготовления</p>
        </div>
        <Link
          to="/settings/printers/queue"
          className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-border rounded-lg hover:bg-muted transition-colors bg-white shrink-0"
        >
          <ListOrdered className="size-3.5" />
          Очередь печати
        </Link>
      </div>

      {/* Print Server Status — compact indicator */}
      <div className={`rounded-xl border-2 p-4 flex items-center justify-between ${serverStatus === 'online' ? 'border-emerald-200 bg-emerald-50/50' : 'border-amber-200 bg-amber-50/50'}`}>
        <div className="flex items-center gap-3">
          <div className={`size-10 rounded-xl flex items-center justify-center ${serverStatus === 'online' ? 'bg-emerald-100' : 'bg-amber-100'}`}>
            {serverStatus === 'online' ? <Wifi className="size-5 text-emerald-600" /> : <WifiOff className="size-5 text-amber-600" />}
          </div>
          <div>
            <p className="font-semibold text-foreground text-sm">
              {serverStatus === 'online' ? 'Принт-сервер готов' : serverStatus === 'checking' ? 'Проверка...' : 'Принт-сервер недоступен'}
            </p>
            <p className="text-xs text-muted-foreground">
              {isDesktop
                ? 'Встроен в десктопное приложение RestOS'
                : serverStatus === 'online'
                  ? 'Подключение через RestOS на кассовом ПК'
                  : 'Откройте RestOS на кассовом компьютере'}
            </p>
          </div>
        </div>
        <button onClick={checkServer}
          className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-border rounded-lg hover:bg-muted transition-colors bg-white">
          <RefreshCw className={`size-3.5 ${serverStatus === 'checking' ? 'animate-spin' : ''}`} />Проверить
        </button>
      </div>

      {/* Station → Printer mapping */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-foreground">Станции и принтеры</h2>

        {printers.map(p => (
          <div key={p.station} className={`rounded-xl border p-4 transition-colors ${p.enabled ? 'border-primary/30 bg-primary/5' : 'border-border bg-card'}`}>
            <div className="flex items-center gap-3">
              {/* Station info */}
              <div className="flex items-center gap-2 min-w-[120px]">
                <span className="text-xl">{STATION_ICONS[p.station]}</span>
                <span className="text-sm font-medium text-foreground">{STATION_LABELS[p.station]}</span>
              </div>

              {/* Printer IP */}
              <input
                type="text"
                value={p.printerIP || ''}
                onChange={e => updatePrinter(p.station, { printerIP: e.target.value })}
                placeholder="IP принтера (192.168.x.x)"
                className="flex-1 px-3 py-2 text-sm bg-background border border-border rounded-lg"
              />

              {/* Enable toggle */}
              <button
                onClick={() => updatePrinter(p.station, { enabled: !p.enabled })}
                className={`size-8 rounded-lg flex items-center justify-center border-2 transition-all ${
                  p.enabled ? 'bg-emerald-500 border-emerald-500 text-white' : 'bg-muted/50 border-border text-muted-foreground/30'
                }`}
              >
                {p.enabled && <CheckCircle2 className="size-4" />}
              </button>

              {/* Test print */}
              <button
                onClick={() => handleTestPrint(p.station)}
                disabled={!p.printerIP || serverStatus !== 'online'}
                title="Тестовая печать"
                className="p-2 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:opacity-30"
              >
                <TestTube className="size-4" />
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Receipt (cashier) printer */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-foreground">Принтер кассы (гостевой чек)</h2>
        <div className={`rounded-xl border p-4 transition-colors ${receiptPrinter.enabled ? 'border-blue-300 bg-blue-50/50' : 'border-border bg-card'}`}>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 min-w-[120px]">
              <Receipt className="size-5 text-blue-600" />
              <span className="text-sm font-medium text-foreground">Касса</span>
            </div>
            <input
              type="text"
              value={receiptPrinter.printerIP || ''}
              onChange={e => setReceiptPrinterState(p => ({ ...p, printerIP: e.target.value }))}
              placeholder="IP принтера (192.168.x.x)"
              className="flex-1 px-3 py-2 text-sm bg-background border border-border rounded-lg"
            />
            <button
              onClick={() => setReceiptPrinterState(p => ({ ...p, enabled: !p.enabled }))}
              className={`size-8 rounded-lg flex items-center justify-center border-2 transition-all ${
                receiptPrinter.enabled ? 'bg-emerald-500 border-emerald-500 text-white' : 'bg-muted/50 border-border text-muted-foreground/30'
              }`}
            >
              {receiptPrinter.enabled && <CheckCircle2 className="size-4" />}
            </button>
            <button
              onClick={handleTestReceipt}
              disabled={!receiptPrinter.printerIP || serverStatus !== 'online'}
              title="Тестовая печать"
              className="p-2 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:opacity-30"
            >
              <TestTube className="size-4" />
            </button>
          </div>
          <p className="text-[11px] text-muted-foreground mt-2">
            Используется для печати пре-чека и гостевого счёта. Если не указан — будет использован первый из принтеров станций.
          </p>
        </div>
      </div>

      {/* Save */}
      <button onClick={handleSave}
        className="w-full flex items-center justify-center gap-2 bg-primary text-primary-foreground px-5 py-3 rounded-xl text-sm font-medium hover:bg-primary/90 transition-colors">
        <Save className="size-4" />
        Сохранить настройки
      </button>

      {/* Instructions */}
      <div className="bg-muted/30 rounded-xl border border-border p-5 space-y-3">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Printer className="size-4" />Инструкция по настройке
        </h3>
        <ol className="text-xs text-muted-foreground space-y-2 list-decimal list-inside">
          <li>Откройте <strong>RestOS</strong> на кассовом компьютере — принт-сервер уже встроен.</li>
          <li>Подключите термопринтер к роутеру <strong>LAN-кабелем</strong>. USB-принтеры не поддерживаются.</li>
          <li>Узнайте IP принтера: зажмите кнопку <strong>Feed</strong> при включении — принтер распечатает свой IP.</li>
          <li>Впишите IP в нужную станцию (например Кухня — 192.168.1.100).</li>
          <li>Включите станцию галочкой и нажмите <TestTube className="inline size-3" /> для тестовой печати.</li>
          <li>Сохраните настройки.</li>
        </ol>
        <p className="text-xs text-muted-foreground/70">
          Настройки сохраняются локально в браузере и действуют только на этом устройстве. На других кассах настройте отдельно.
        </p>
      </div>
    </div>
  )
}
