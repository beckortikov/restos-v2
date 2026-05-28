'use client'

import { useState, useRef } from 'react'
import { useAuth } from '@/lib/auth-store'
import { createZone, createTable, fetchZones, fetchTables, createMenuItem, createIngredient, fetchMenuItems, fetchIngredients } from '@/lib/queries'
import { api, unwrap } from '@/lib/api'
import {
  parseFloorMapExcel, parseDishesExcel, parseTechCardsExcel, parseIngredientsExcel,
  type ParsedFloorMap, type ParsedDishList, type ParsedTechCards, type ParsedIngredientList,
} from '@/lib/import-excel'
import {
  Upload, FileSpreadsheet, CheckCircle2, AlertTriangle, MapPin, Armchair,
  Loader2, Download, ChefHat, Package, X, ArrowLeft,
} from 'lucide-react'
import { toast } from 'sonner'

type ImportType = null | 'floor-map' | 'menu' | 'techcards' | 'inventory'
type ImportStep = 'upload' | 'preview' | 'importing' | 'done'

const IMPORT_CARDS = [
  {
    type: 'floor-map' as const,
    icon: MapPin,
    color: 'bg-blue-100 text-blue-600',
    title: 'Карта зала',
    desc: 'Зоны и столы ресторана',
    template: '/docs/шаблон-карта-зала.xlsx',
    ready: true,
  },
  {
    type: 'menu' as const,
    icon: ChefHat,
    color: 'bg-primary/10 text-primary',
    title: 'Блюда (меню)',
    desc: 'Лист "Блюда" — включая продажу по весу',
    template: '/docs/шаблон-техкарты.xlsx',
    ready: true,
  },
  {
    type: 'techcards' as const,
    icon: FileSpreadsheet,
    color: 'bg-amber-100 text-amber-600',
    title: 'Техкарты',
    desc: 'Лист "Техкарты"',
    template: '/docs/шаблон-техкарты.xlsx',
    ready: true,
  },
  {
    type: 'inventory' as const,
    icon: Package,
    color: 'bg-emerald-100 text-emerald-600',
    title: 'Ингредиенты',
    desc: 'Лист "Ингредиенты"',
    template: '/docs/шаблон-техкарты.xlsx',
    ready: true,
  },
]

export default function ImportPage() {
  const { canDo } = useAuth()
  const fileRef = useRef<HTMLInputElement>(null)
  const [activeType, setActiveType] = useState<ImportType>(null)
  const [step, setStep] = useState<ImportStep>('upload')
  const [parsed, setParsed] = useState<ParsedFloorMap | null>(null)
  const [parsedDishes, setParsedDishes] = useState<ParsedDishList | null>(null)
  const [parsedIngredients, setParsedIngredients] = useState<ParsedIngredientList | null>(null)
  const [parsedTechCards, setParsedTechCards] = useState<ParsedTechCards | null>(null)
  const [importResult, setImportResult] = useState<{ created: number; label: string; errors: string[]; zonesCreated?: number; tablesCreated?: number } | null>(null)

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      if (activeType === 'floor-map') {
        const result = await parseFloorMapExcel(file)
        setParsed(result)
      } else if (activeType === 'menu') {
        const result = await parseDishesExcel(file)
        setParsedDishes(result)
      } else if (activeType === 'techcards') {
        const result = await parseTechCardsExcel(file)
        setParsedTechCards(result)
      } else if (activeType === 'inventory') {
        const result = await parseIngredientsExcel(file)
        setParsedIngredients(result)
      }
      setStep('preview')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Ошибка чтения файла')
    }
  }

  const handleImportFloorMap = async () => {
    if (!parsed) return
    setStep('importing')
    const errors: string[] = []
    let zonesCreated = 0
    let tablesCreated = 0

    try {
      // Check restaurant_id is set
      const stored = localStorage.getItem('restos-auth-user')
      const rid = stored ? JSON.parse(stored)?.restaurantId : null
      if (!rid) {
        errors.push('Ошибка: restaurant_id не найден. Перелогиньтесь.')
        setImportResult({ created: 0, label: '0', errors })
        setStep('done')
        return
      }

      const existingZones = await fetchZones()
      const existingZoneMap = new Map(existingZones.map(z => [z.name.toLowerCase(), z.id]))
      const zoneIdMap = new Map<string, string>()

      for (const zone of parsed.zones) {
        const existing = existingZoneMap.get(zone.name.toLowerCase())
        if (existing) {
          zoneIdMap.set(zone.name.toLowerCase(), existing)
        } else {
          try {
            const created = await createZone(zone.name)
            if (created?.id) { zoneIdMap.set(zone.name.toLowerCase(), created.id); zonesCreated++ }
          } catch (err) { errors.push(`Зона "${zone.name}": ${err instanceof Error ? err.message : 'ошибка'}`) }
        }
      }

      // Check existing tables to skip duplicates
      const existingTables = await fetchTables()
      const existingTableNames = new Set(existingTables.map(t => t.name.toLowerCase()))

      for (const table of parsed.tables) {
        const zoneId = zoneIdMap.get(table.zone.toLowerCase())
        if (!zoneId) { errors.push(`Стол "${table.name}": зона "${table.zone}" не найдена`); continue }
        if (existingTableNames.has(table.name.toLowerCase())) continue // skip existing
        try {
          await createTable({ name: table.name, number: table.number, capacity: table.capacity, zone_id: zoneId })
          tablesCreated++
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Неизвестная ошибка'
          errors.push(`Стол "${table.name}": ${msg}`)
        }
      }
    } catch (err) { errors.push(`Ошибка: ${err instanceof Error ? err.message : String(err)}`) }

    setImportResult({ created: zonesCreated + tablesCreated, label: `${zonesCreated} зон, ${tablesCreated} столов`, errors, zonesCreated, tablesCreated })
    setStep('done')
    if (errors.length === 0) toast.success(`Импорт: ${zonesCreated} зон, ${tablesCreated} столов`)
    else toast.error(`Ошибки: ${errors.length}`)
  }

  const handleImportDishes = async () => {
    if (!parsedDishes) return
    setStep('importing')
    const errors: string[] = []
    let created = 0
    for (const dish of parsedDishes.dishes) {
      try {
        await createMenuItem({
          name: dish.name, category: dish.category, price: dish.price, cogs: dish.cogs,
          emoji: '', isAvailable: dish.isAvailable, station: dish.station as import('@/lib/types').MenuStation,
          cookTimeMin: dish.cookTimeMin || null, techCard: [], stopListOverride: false,
          unit: dish.unit, unitSize: dish.unitSize, saleStep: dish.saleStep,
          isBatchCooking: false, preparedQty: 0,
        })
        created++
      } catch (err) { errors.push(`"${dish.name}": ${err instanceof Error ? err.message : 'ошибка'}`) }
    }
    setImportResult({ created, label: `${created} блюд`, errors })
    setStep('done')
    if (errors.length === 0) toast.success(`Импорт: ${created} блюд`)
    else toast.error(`Ошибки: ${errors.length}`)
  }

  const handleImportIngredients = async () => {
    if (!parsedIngredients) return
    setStep('importing')
    const errors: string[] = []
    let created = 0
    for (const ing of parsedIngredients.ingredients) {
      try {
        await createIngredient({
          name: ing.name, category: ing.category, qty: 0, min_qty: ing.minQty,
          unit: ing.unit, price_per_unit: ing.pricePerUnit, waste_percent: ing.wastePercent,
        })
        created++
      } catch (err) { errors.push(`"${ing.name}": ${err instanceof Error ? err.message : 'ошибка'}`) }
    }
    setImportResult({ created, label: `${created} ингредиентов`, errors })
    setStep('done')
    if (errors.length === 0) toast.success(`Импорт: ${created} ингредиентов`)
    else toast.error(`Ошибки: ${errors.length}`)
  }

  const handleImportTechCards = async () => {
    if (!parsedTechCards) return
    setStep('importing')
    const errors: string[] = []
    let created = 0

    try {
      // Load existing menu items and ingredients to match by name
      const [menuItems, ingredients] = await Promise.all([fetchMenuItems(), fetchIngredients()])
      const menuMap = new Map(menuItems.map(m => [m.name.toLowerCase(), m.id]))
      const ingMap = new Map(ingredients.map(i => [i.name.toLowerCase(), i.id]))

      // Group lines by dish
      const byDish = new Map<string, typeof parsedTechCards.lines>()
      for (const line of parsedTechCards.lines) {
        const key = line.dishName.toLowerCase()
        if (!byDish.has(key)) byDish.set(key, [])
        byDish.get(key)!.push(line)
      }

      for (const [dishKey, lines] of byDish) {
        const menuItemId = menuMap.get(dishKey)
        if (!menuItemId) {
          errors.push(`Блюдо "${lines[0].dishName}" не найдено в меню — сначала импортируйте блюда`)
          continue
        }

        // Delete existing tech card lines for this dish (one DELETE per row
        // — v4 has no bulk-delete; that's acceptable for an admin import flow).
        try {
          const existing: any = await unwrap(api.GET('/api/v1/menu/tech-cards', { params: { query: { menu_item_id: menuItemId } } }))
          const exRows: any[] = Array.isArray(existing?.data) ? existing.data : Array.isArray(existing) ? existing : []
          for (const row of exRows) {
            if (row?.id) {
              try { await unwrap(api.DELETE('/api/v1/menu/tech-cards/{id}', { params: { path: { id: row.id } } })) } catch {}
            }
          }
        } catch {}

        const missingIngs = lines.filter(l => !ingMap.get(l.ingredientName.toLowerCase()))
        if (missingIngs.length > 0) {
          errors.push(`"${lines[0].dishName}": ингредиенты не найдены — ${missingIngs.map(l => l.ingredientName).join(', ')}`)
        }

        // Insert new lines via v4 (one POST per line).
        let insertFailed = false
        for (const l of lines) {
          const ingId = ingMap.get(l.ingredientName.toLowerCase())
          try {
            await unwrap(api.POST('/api/v1/menu/tech-cards', {
              body: {
                menu_item_id: menuItemId,
                ingredient_id: ingId || null,
                name: l.ingredientName,
                qty: String(l.massG),
                unit: l.unit,
              } as any,
            }))
          } catch (err) {
            insertFailed = true
            errors.push(`"${lines[0].dishName}": ${err instanceof Error ? err.message : String(err)}`)
            break
          }
        }
        if (!insertFailed) created++
      }
    } catch (err) {
      errors.push(`Ошибка: ${err instanceof Error ? err.message : String(err)}`)
    }

    setImportResult({ created, label: `${created} техкарт`, errors })
    setStep('done')
    if (errors.length === 0) toast.success(`Импорт: ${created} техкарт`)
    else toast.error(`С ошибками: ${errors.length}`)
  }

  const reset = () => {
    setActiveType(null); setStep('upload'); setParsed(null); setParsedDishes(null); setParsedIngredients(null); setParsedTechCards(null); setImportResult(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  const goBack = () => {
    setStep('upload'); setParsed(null); setImportResult(null)
    if (fileRef.current) fileRef.current.value = ''
    if (step === 'upload') setActiveType(null)
  }

  if (!canDo('data.import')) {
    return <div className="p-6 flex items-center justify-center h-64"><p className="text-muted-foreground">Нет доступа</p></div>
  }

  const activeCard = IMPORT_CARDS.find(c => c.type === activeType)

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-4xl">
      {/* Header */}
      <div className="flex items-center gap-3">
        {activeType && (
          <button onClick={goBack} className="p-1.5 rounded-lg text-muted-foreground hover:bg-muted transition-colors">
            <ArrowLeft className="size-5" />
          </button>
        )}
        <div>
          <h1 className="text-xl font-bold text-foreground">
            {activeType ? `Импорт: ${activeCard?.title}` : 'Импорт данных'}
          </h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            {activeType ? activeCard?.desc : 'Загрузите данные из Excel-шаблонов'}
          </p>
        </div>
      </div>

      {/* ═══ Export current menu (banner) ═══ */}
      {!activeType && <ExportMenuBanner />}

      {/* ═══ Type selection ═══ */}
      {!activeType && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {IMPORT_CARDS.map(card => (
            <button
              key={card.type}
              onClick={() => card.ready ? setActiveType(card.type) : toast.info('Скоро будет доступно')}
              className={`relative bg-card rounded-xl border-2 p-4 text-left transition-all hover:shadow-md ${
                card.ready ? 'border-border hover:border-primary/40 cursor-pointer' : 'border-border/50 opacity-60 cursor-default'
              }`}
            >
              {!card.ready && (
                <span className="absolute top-2 right-2 text-[9px] bg-muted text-muted-foreground px-1.5 py-0.5 rounded-full font-medium">Скоро</span>
              )}
              <div className={`size-10 rounded-lg flex items-center justify-center mb-3 ${card.color}`}>
                <card.icon className="size-5" />
              </div>
              <h3 className="font-semibold text-foreground text-sm">{card.title}</h3>
              <p className="text-[11px] text-muted-foreground mt-0.5 leading-tight">{card.desc}</p>
              {card.template && card.ready && (
                <div className="mt-2 pt-2 border-t border-border flex items-center gap-1 text-[10px] text-primary">
                  <FileSpreadsheet className="size-3" />Шаблон
                </div>
              )}
            </button>
          ))}
        </div>
      )}

      {/* ═══ Floor Map Import ═══ */}
      {activeType === 'floor-map' && (
        <>
          {/* Step 1: Upload */}
          {step === 'upload' && (
            <div className="space-y-4">
              {/* How it works */}
              <div className="bg-blue-50 rounded-xl border border-blue-200 p-5 space-y-3">
                <h3 className="text-sm font-semibold text-blue-900">Как это работает</h3>
                <ol className="text-xs text-blue-800 space-y-1.5 list-decimal list-inside">
                  <li>Скачайте шаблон Excel</li>
                  <li>На листе <strong>&quot;Зоны&quot;</strong> — впишите зоны ресторана (Основной зал, Терраса, VIP...)</li>
                  <li>На листе <strong>&quot;Столы&quot;</strong> — впишите столы с номером, вместимостью и зоной</li>
                  <li>Загрузите заполненный файл сюда</li>
                </ol>
              </div>

              {/* Download template */}
              <div className="flex items-center gap-3 bg-card rounded-xl border border-border p-4">
                <div className="size-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                  <FileSpreadsheet className="size-5 text-primary" />
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium text-foreground">Шаблон карты зала</p>
                  <p className="text-xs text-muted-foreground">Excel с примерами зон и столов</p>
                </div>
                <a href="/docs/шаблон-карта-зала.xlsx" download
                  className="flex items-center gap-1.5 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors">
                  <Download className="size-4" />Скачать
                </a>
              </div>

              {/* Upload area */}
              <div
                onClick={() => fileRef.current?.click()}
                className="border-2 border-dashed border-border rounded-2xl p-10 text-center cursor-pointer hover:border-primary/40 hover:bg-primary/5 transition-all group"
              >
                <div className="size-14 rounded-2xl bg-muted flex items-center justify-center mx-auto mb-3 group-hover:bg-primary/10 transition-colors">
                  <Upload className="size-6 text-muted-foreground group-hover:text-primary transition-colors" />
                </div>
                <p className="font-medium text-foreground">Загрузить заполненный шаблон</p>
                <p className="text-sm text-muted-foreground mt-1">Нажмите или перетащите файл (.xlsx)</p>
                <input ref={fileRef} type="file" accept=".xlsx,.xls,.xlsm" onChange={handleFileSelect} className="hidden" />
              </div>
            </div>
          )}

          {/* Step 2: Preview */}
          {step === 'preview' && parsed && (
            <div className="space-y-4">
              {parsed.errors.length > 0 && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 space-y-2">
                  <h3 className="text-sm font-semibold text-amber-800 flex items-center gap-2">
                    <AlertTriangle className="size-4" />Предупреждения ({parsed.errors.length})
                  </h3>
                  <ul className="text-xs text-amber-700 space-y-1">
                    {parsed.errors.map((err, i) => <li key={i}>• {err}</li>)}
                  </ul>
                </div>
              )}

              {/* Zones */}
              <div className="bg-card rounded-xl border border-border p-5 space-y-3">
                <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <MapPin className="size-4 text-blue-600" />Зоны ({parsed.zones.length})
                </h3>
                <div className="flex flex-wrap gap-2">
                  {parsed.zones.map((z, i) => (
                    <span key={i} className="px-3 py-1.5 bg-blue-50 text-blue-700 border border-blue-200 rounded-lg text-xs font-medium">{z.name}</span>
                  ))}
                </div>
              </div>

              {/* Tables */}
              <div className="bg-card rounded-xl border border-border p-5 space-y-3">
                <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <Armchair className="size-4 text-primary" />Столы ({parsed.tables.length})
                  <span className="text-xs text-muted-foreground ml-auto">{parsed.tables.reduce((s, t) => s + t.capacity, 0)} мест</span>
                </h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="px-3 py-2 text-left text-xs text-muted-foreground font-medium">Название</th>
                        <th className="px-3 py-2 text-center text-xs text-muted-foreground font-medium">№</th>
                        <th className="px-3 py-2 text-center text-xs text-muted-foreground font-medium">Мест</th>
                        <th className="px-3 py-2 text-left text-xs text-muted-foreground font-medium">Зона</th>
                      </tr>
                    </thead>
                    <tbody>
                      {parsed.tables.map((t, i) => (
                        <tr key={i} className="border-b border-border/50 hover:bg-muted/20">
                          <td className="px-3 py-2 font-medium text-foreground">{t.name}</td>
                          <td className="px-3 py-2 text-center text-muted-foreground">{t.number}</td>
                          <td className="px-3 py-2 text-center text-foreground">{t.capacity}</td>
                          <td className="px-3 py-2"><span className="text-xs bg-muted px-2 py-0.5 rounded">{t.zone}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="flex gap-3">
                <button onClick={goBack}
                  className="flex-1 px-4 py-2.5 text-sm font-medium text-foreground bg-card border border-border rounded-xl hover:bg-muted transition-colors">
                  Назад
                </button>
                <button onClick={handleImportFloorMap}
                  disabled={parsed.zones.length === 0 || parsed.tables.length === 0}
                  className="flex-1 px-4 py-2.5 text-sm font-medium text-primary-foreground bg-primary rounded-xl hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
                  <Upload className="size-4" />
                  Импортировать
                </button>
              </div>
            </div>
          )}

          {/* Step 3: Importing */}
          {step === 'importing' && (
            <div className="bg-card rounded-2xl border border-border p-12 text-center">
              <Loader2 className="size-10 text-primary mx-auto mb-3 animate-spin" />
              <p className="font-medium text-foreground">Создаём зоны и столы...</p>
            </div>
          )}

          {/* Step 4: Done */}
          {step === 'done' && importResult && (
            <div className="space-y-4">
              <div className={`rounded-2xl border-2 p-8 text-center ${importResult.errors.length === 0 ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-200'}`}>
                {importResult.errors.length === 0 ? (
                  <CheckCircle2 className="size-14 text-emerald-500 mx-auto mb-3" />
                ) : (
                  <AlertTriangle className="size-14 text-amber-500 mx-auto mb-3" />
                )}
                <h3 className="text-xl font-bold text-foreground">
                  {importResult.errors.length === 0 ? 'Карта зала импортирована!' : 'Импорт завершён с ошибками'}
                </h3>
                <div className="flex items-center justify-center gap-8 mt-4">
                  <div>
                    <p className="text-3xl font-bold text-primary">{importResult.zonesCreated}</p>
                    <p className="text-xs text-muted-foreground">зон</p>
                  </div>
                  <div>
                    <p className="text-3xl font-bold text-primary">{importResult.tablesCreated}</p>
                    <p className="text-xs text-muted-foreground">столов</p>
                  </div>
                </div>
              </div>

              {importResult.errors.length > 0 && (
                <div className="bg-card rounded-xl border border-border p-4">
                  <h4 className="text-sm font-semibold text-destructive mb-2">Ошибки</h4>
                  <ul className="text-xs text-muted-foreground space-y-1">
                    {importResult.errors.map((err, i) => <li key={i}>• {err}</li>)}
                  </ul>
                </div>
              )}

              <div className="flex gap-3">
                <button onClick={reset} className="flex-1 px-4 py-2.5 text-sm font-medium text-foreground bg-card border border-border rounded-xl hover:bg-muted">
                  Импортировать ещё
                </button>
                <a href="/operations/table-map" className="flex-1 px-4 py-2.5 text-sm font-medium text-primary-foreground bg-primary rounded-xl hover:bg-primary/90 text-center">
                  Открыть карту зала →
                </a>
              </div>
            </div>
          )}
        </>
      )}

      {/* ═══ Dishes / Ingredients Import ═══ */}
      {(activeType === 'menu' || activeType === 'techcards' || activeType === 'inventory') && (
        <>
          {step === 'upload' && (
            <div className="space-y-4">
              {/* Download template */}
              {activeCard?.template && (
                <div className="flex items-center gap-3 bg-card rounded-xl border border-border p-4">
                  <div className={`size-10 rounded-lg flex items-center justify-center shrink-0 ${activeCard.color}`}>
                    <FileSpreadsheet className="size-5" />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-medium text-foreground">Шаблон техкарт</p>
                    <p className="text-xs text-muted-foreground">Excel с листами: Блюда, Техкарты, Ингредиенты</p>
                  </div>
                  <a href={activeCard.template} download
                    className="flex items-center gap-1.5 px-3 py-2 bg-primary text-primary-foreground rounded-lg text-xs font-medium hover:bg-primary/90 transition-colors">
                    <Download className="size-3.5" />Скачать
                  </a>
                </div>
              )}

              <div className={`${activeType === 'menu' ? 'bg-primary/5 border-primary/20' : activeType === 'techcards' ? 'bg-amber-50 border-amber-200' : 'bg-emerald-50 border-emerald-200'} rounded-xl border p-5 space-y-3`}>
                <h3 className="text-sm font-semibold text-foreground">Как импортировать</h3>
                <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside">
                  <li>Скачайте шаблон <strong>шаблон-техкарты.xlsx</strong> кнопкой ниже</li>
                  <li>Перейдите на лист <strong>&quot;{activeType === 'menu' ? 'Блюда' : activeType === 'techcards' ? 'Техкарты' : 'Ингредиенты'}&quot;</strong></li>
                  <li>Заполните данные. Для продажи по весу (салаты, сыры) укажите колонки M, N, O — подробности в листе «Инструкция»</li>
                  <li>Загрузите файл сюда — система прочитает нужный лист</li>
                </ol>
                {activeType === 'menu' && (
                  <div className="pt-2 mt-2 border-t border-border/50 text-[11px] text-muted-foreground space-y-1">
                    <p className="font-semibold text-foreground">Для блюд по весу (новое):</p>
                    <p>• Колонка <strong>Ед. продажи</strong>: <code>piece</code> (штучно — по умолчанию), <code>g</code> (за граммы), <code>kg</code> (за кг)</p>
                    <p>• Колонка <strong>Размер порции (г)</strong>: для <code>g</code> — за сколько граммов указана цена (обычно 100)</p>
                    <p>• Колонка <strong>Шаг (г)</strong>: минимальный шаг на весах (50 = округление; 0 = любой вес)</p>
                    <p className="italic">Пример: салат 25 TJS за 100 г → <code>g / 100 / 50</code></p>
                  </div>
                )}
              </div>

              <div
                onClick={() => fileRef.current?.click()}
                className="border-2 border-dashed border-border rounded-2xl p-10 text-center cursor-pointer hover:border-primary/40 hover:bg-primary/5 transition-all group"
              >
                <div className="size-14 rounded-2xl bg-muted flex items-center justify-center mx-auto mb-3 group-hover:bg-primary/10 transition-colors">
                  <Upload className="size-6 text-muted-foreground group-hover:text-primary transition-colors" />
                </div>
                <p className="font-medium text-foreground">Загрузить файл техкарт</p>
                <p className="text-sm text-muted-foreground mt-1">Будет прочитан лист &quot;{activeType === 'menu' ? 'Блюда' : activeType === 'techcards' ? 'Техкарты' : 'Ингредиенты'}&quot;</p>
                <input ref={fileRef} type="file" accept=".xlsx,.xls,.xlsm" onChange={handleFileSelect} className="hidden" />
              </div>
            </div>
          )}

          {/* Preview: Dishes */}
          {step === 'preview' && activeType === 'menu' && parsedDishes && (
            <div className="space-y-4">
              {parsedDishes.errors.length > 0 && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
                  <h3 className="text-sm font-semibold text-amber-800 flex items-center gap-2"><AlertTriangle className="size-4" />Предупреждения</h3>
                  <ul className="text-xs text-amber-700 mt-2 space-y-1">{parsedDishes.errors.map((e, i) => <li key={i}>• {e}</li>)}</ul>
                </div>
              )}
              <div className="bg-card rounded-xl border border-border p-5 space-y-3">
                <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <ChefHat className="size-4 text-primary" />Блюда ({parsedDishes.dishes.length})
                </h3>
                <div className="overflow-x-auto max-h-80">
                  <table className="w-full text-xs">
                    <thead><tr className="border-b border-border">
                      <th className="px-2 py-1.5 text-left text-muted-foreground">Название</th>
                      <th className="px-2 py-1.5 text-left text-muted-foreground">Категория</th>
                      <th className="px-2 py-1.5 text-left text-muted-foreground">Станция</th>
                      <th className="px-2 py-1.5 text-right text-muted-foreground">Цена</th>
                      <th className="px-2 py-1.5 text-right text-muted-foreground">Себест.</th>
                    </tr></thead>
                    <tbody>
                      {parsedDishes.dishes.map((d, i) => (
                        <tr key={i} className="border-b border-border/50">
                          <td className="px-2 py-1.5 font-medium text-foreground">{d.name}</td>
                          <td className="px-2 py-1.5 text-muted-foreground">{d.category}</td>
                          <td className="px-2 py-1.5"><span className="bg-muted px-1.5 py-0.5 rounded text-[10px]">{d.station}</span></td>
                          <td className="px-2 py-1.5 text-right">{d.price > 0 ? d.price : <span className="text-amber-600">—</span>}</td>
                          <td className="px-2 py-1.5 text-right text-muted-foreground">{d.cogs.toFixed(1)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="flex gap-3">
                <button onClick={goBack} className="flex-1 px-4 py-2.5 text-sm font-medium text-foreground bg-card border border-border rounded-xl hover:bg-muted">Назад</button>
                <button onClick={handleImportDishes} className="flex-1 px-4 py-2.5 text-sm font-medium text-primary-foreground bg-primary rounded-xl hover:bg-primary/90 flex items-center justify-center gap-2">
                  <Upload className="size-4" />Импортировать {parsedDishes.dishes.length} блюд
                </button>
              </div>
            </div>
          )}

          {/* Preview: Ingredients */}
          {step === 'preview' && activeType === 'inventory' && parsedIngredients && (
            <div className="space-y-4">
              {parsedIngredients.errors.length > 0 && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
                  <h3 className="text-sm font-semibold text-amber-800 flex items-center gap-2"><AlertTriangle className="size-4" />Предупреждения</h3>
                  <ul className="text-xs text-amber-700 mt-2 space-y-1">{parsedIngredients.errors.map((e, i) => <li key={i}>• {e}</li>)}</ul>
                </div>
              )}
              <div className="bg-card rounded-xl border border-border p-5 space-y-3">
                <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <Package className="size-4 text-emerald-600" />Ингредиенты ({parsedIngredients.ingredients.length})
                </h3>
                <div className="overflow-x-auto max-h-80">
                  <table className="w-full text-xs">
                    <thead><tr className="border-b border-border">
                      <th className="px-2 py-1.5 text-left text-muted-foreground">Ингредиент</th>
                      <th className="px-2 py-1.5 text-left text-muted-foreground">Ед.</th>
                      <th className="px-2 py-1.5 text-right text-muted-foreground">Цена</th>
                      <th className="px-2 py-1.5 text-right text-muted-foreground">Отходы %</th>
                      <th className="px-2 py-1.5 text-left text-muted-foreground">Категория</th>
                    </tr></thead>
                    <tbody>
                      {parsedIngredients.ingredients.map((ing, i) => (
                        <tr key={i} className="border-b border-border/50">
                          <td className="px-2 py-1.5 font-medium text-foreground">{ing.name}</td>
                          <td className="px-2 py-1.5 text-muted-foreground">{ing.unit}</td>
                          <td className="px-2 py-1.5 text-right">{ing.pricePerUnit}</td>
                          <td className="px-2 py-1.5 text-right">{ing.wastePercent > 0 ? `${ing.wastePercent}%` : '—'}</td>
                          <td className="px-2 py-1.5"><span className="bg-muted px-1.5 py-0.5 rounded text-[10px]">{ing.category}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="flex gap-3">
                <button onClick={goBack} className="flex-1 px-4 py-2.5 text-sm font-medium text-foreground bg-card border border-border rounded-xl hover:bg-muted">Назад</button>
                <button onClick={handleImportIngredients} className="flex-1 px-4 py-2.5 text-sm font-medium text-primary-foreground bg-emerald-600 rounded-xl hover:bg-emerald-700 flex items-center justify-center gap-2">
                  <Upload className="size-4" />Импортировать {parsedIngredients.ingredients.length} ингредиентов
                </button>
              </div>
            </div>
          )}

          {/* Preview: Tech Cards */}
          {step === 'preview' && activeType === 'techcards' && parsedTechCards && (
            <div className="space-y-4">
              {parsedTechCards.errors.length > 0 && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
                  <h3 className="text-sm font-semibold text-amber-800 flex items-center gap-2"><AlertTriangle className="size-4" />Предупреждения</h3>
                  <ul className="text-xs text-amber-700 mt-2 space-y-1">{parsedTechCards.errors.map((e, i) => <li key={i}>• {e}</li>)}</ul>
                </div>
              )}

              <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
                <p className="text-xs text-amber-800">
                  <strong>Важно:</strong> Сначала импортируйте <strong>Блюда</strong> и <strong>Ингредиенты</strong>, затем Техкарты. Система привяжет ингредиенты к блюдам по совпадению названий.
                </p>
              </div>

              <div className="bg-card rounded-xl border border-border p-5 space-y-3">
                <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <FileSpreadsheet className="size-4 text-amber-600" />
                  Техкарты: {parsedTechCards.dishCount} блюд, {parsedTechCards.lines.length} строк
                </h3>
                <div className="overflow-x-auto max-h-80">
                  <table className="w-full text-xs">
                    <thead><tr className="border-b border-border">
                      <th className="px-2 py-1.5 text-left text-muted-foreground">Блюдо</th>
                      <th className="px-2 py-1.5 text-left text-muted-foreground">Ингредиент</th>
                      <th className="px-2 py-1.5 text-right text-muted-foreground">Масса (г)</th>
                      <th className="px-2 py-1.5 text-right text-muted-foreground">Стоимость</th>
                    </tr></thead>
                    <tbody>
                      {parsedTechCards.lines.slice(0, 50).map((l, i) => (
                        <tr key={i} className="border-b border-border/50">
                          <td className="px-2 py-1.5 font-medium text-foreground">{l.dishName}</td>
                          <td className="px-2 py-1.5 text-muted-foreground">{l.ingredientName}</td>
                          <td className="px-2 py-1.5 text-right">{l.massG}</td>
                          <td className="px-2 py-1.5 text-right">{l.cost.toFixed(2)}</td>
                        </tr>
                      ))}
                      {parsedTechCards.lines.length > 50 && (
                        <tr><td colSpan={4} className="px-2 py-2 text-center text-muted-foreground">... ещё {parsedTechCards.lines.length - 50} строк</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="flex gap-3">
                <button onClick={goBack} className="flex-1 px-4 py-2.5 text-sm font-medium text-foreground bg-card border border-border rounded-xl hover:bg-muted">Назад</button>
                <button onClick={handleImportTechCards} className="flex-1 px-4 py-2.5 text-sm font-medium text-primary-foreground bg-amber-600 rounded-xl hover:bg-amber-700 flex items-center justify-center gap-2">
                  <Upload className="size-4" />Импортировать {parsedTechCards.dishCount} техкарт
                </button>
              </div>
            </div>
          )}

          {/* Importing spinner */}
          {step === 'importing' && (
            <div className="bg-card rounded-2xl border border-border p-12 text-center">
              <Loader2 className="size-10 text-primary mx-auto mb-3 animate-spin" />
              <p className="font-medium text-foreground">Импортируем данные...</p>
            </div>
          )}

          {/* Done */}
          {step === 'done' && importResult && (
            <div className="space-y-4">
              <div className={`rounded-2xl border-2 p-8 text-center ${importResult.errors.length === 0 ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-200'}`}>
                {importResult.errors.length === 0 ? <CheckCircle2 className="size-14 text-emerald-500 mx-auto mb-3" /> : <AlertTriangle className="size-14 text-amber-500 mx-auto mb-3" />}
                <h3 className="text-xl font-bold text-foreground">Импортировано: {importResult.label}</h3>
              </div>
              {importResult.errors.length > 0 && (
                <div className="bg-card rounded-xl border border-border p-4">
                  <h4 className="text-sm font-semibold text-destructive mb-2">Ошибки</h4>
                  <ul className="text-xs text-muted-foreground space-y-1 max-h-40 overflow-y-auto">{importResult.errors.map((e, i) => <li key={i}>• {e}</li>)}</ul>
                </div>
              )}
              <div className="flex gap-3">
                <button onClick={reset} className="flex-1 px-4 py-2.5 text-sm font-medium text-foreground bg-card border border-border rounded-xl hover:bg-muted">Импортировать ещё</button>
                <a href={activeType === 'menu' ? '/warehouse/menu' : activeType === 'techcards' ? '/warehouse/menu' : '/warehouse/inventory'}
                  className="flex-1 px-4 py-2.5 text-sm font-medium text-primary-foreground bg-primary rounded-xl hover:bg-primary/90 text-center">
                  {activeType === 'menu' ? 'Открыть меню →' : activeType === 'techcards' ? 'Открыть меню →' : 'Открыть склад →'}
                </a>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function ExportMenuBanner() {
  const [busy, setBusy] = useState(false)
  const handleExport = async () => {
    setBusy(true)
    try {
      const { exportMenuTemplate } = await import('@/lib/export-excel')
      await exportMenuTemplate()
      toast.success('Меню выгружено в Excel')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка экспорта')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="relative overflow-hidden rounded-2xl border-2 border-primary/20 bg-gradient-to-br from-primary/5 via-card to-amber-50/40 p-5">
      <div className="flex items-start gap-4">
        <div className="size-12 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
          <Download className="size-6" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-base font-semibold text-foreground">Скачать текущее меню</h3>
          <p className="text-sm text-muted-foreground mt-0.5 leading-snug">
            Excel-снимок всех блюд, техкарт и ингредиентов с цехом, ценой,
            себестоимостью, маржой и весом продажи. Можно править и заново
            импортировать обратно.
          </p>
        </div>
        <button
          onClick={handleExport}
          disabled={busy}
          className="shrink-0 inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-60"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <FileSpreadsheet className="size-4" />}
          {busy ? 'Готовится...' : 'Скачать .xlsx'}
        </button>
      </div>
    </div>
  )
}
