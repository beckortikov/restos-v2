'use client'

import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/lib/auth-store'
import { formatCurrency, formatNum } from '@/lib/helpers'
import { type Ingredient } from '@/lib/types'
import { fetchIngredients, fetchIngredientCategories, createIngredient, updateIngredient, deleteIngredient, fetchWarehouses, transferWarehouse, fetchMenuItems } from '@/lib/queries'
import { queryKeys } from '@/lib/query-client'
import { humanizeError } from '@/lib/errors'

import { Search, Plus, Trash2, X, Check, ArrowRightLeft, ShoppingCart, Pencil, PackageMinus, ChevronRight, Download, Layers } from 'lucide-react'
import { exportToExcel } from '@/lib/export-excel'
import { ManageIngredientDialog } from '@/components/dialogs/manage-ingredient-dialog'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { toast } from 'sonner'

type WhKind = 'products' | 'purchased' | 'supplies'
const WH_TABS: { kind: WhKind; label: string }[] = [
  { kind: 'products', label: 'Продукты' },
  { kind: 'purchased', label: 'Покупные' },
  { kind: 'supplies', label: 'Хозтовары' },
]
type StatusFilter = 'all' | 'low' | 'out'

// Остатки (редизайн): тач-карточки вместо десктоп-таблицы. Тап по позиции →
// лист действий (Закупить / Переместить / Править / Списать / Удалить).
// Точка-индикатор ок/мало/нет читается мгновенно. Логика данных, диалоги
// правки/перемещения и массовое удаление сохранены как были.
export default function InventoryPage() {
  const { canDo } = useAuth()
  const navigate = useNavigate()
  const canManage = canDo('inventory.manage')
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('all')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [whKind, setWhKind] = useState<WhKind>('products')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingIngredient, setEditingIngredient] = useState<Ingredient | undefined>(undefined)
  const [actionItem, setActionItem] = useState<Ingredient | null>(null)
  // Мультивыбор для удаления.
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState(false)
  const [dupOpen, setDupOpen] = useState(false)

  const qc = useQueryClient()
  const CATS_KEY = ['stock', 'ingredient-categories'] as const
  const ingredientsQuery = useQuery({ queryKey: queryKeys.stock.ingredients, queryFn: fetchIngredients })
  const ingredients = ingredientsQuery.data ?? []
  useQuery({ queryKey: CATS_KEY, queryFn: fetchIngredientCategories, staleTime: 5 * 60_000 })
  const { data: warehouses = [] } = useQuery({ queryKey: ['warehouses'], queryFn: fetchWarehouses, staleTime: 10 * 60_000 })
  const warehouseById = useMemo(() => new Map(warehouses.map(w => [w.id, w])), [warehouses])
  const [moveTarget, setMoveTarget] = useState<Ingredient | null>(null)
  const [moving, setMoving] = useState(false)
  const loading = ingredientsQuery.isLoading
  const reloadStock = () => {
    qc.invalidateQueries({ queryKey: queryKeys.stock.ingredients })
    qc.invalidateQueries({ queryKey: CATS_KEY })
  }

  async function doMove(toWarehouseId: string) {
    if (!moveTarget || moving) return
    setMoving(true)
    try {
      await transferWarehouse(moveTarget.id, toWarehouseId)
      toast.success(`«${moveTarget.name}» перемещён`)
      setMoveTarget(null)
      qc.invalidateQueries({ queryKey: queryKeys.stock.ingredients })
    } catch (e) {
      toast.error(humanizeError(e, 'Не удалось переместить'))
    } finally {
      setMoving(false)
    }
  }

  async function handleIngredientSubmit(data: { name: string; category: string; unit: string; initialQty?: number; minQty: number; pricePerUnit: number; wastePercent?: number; unitWeight?: number; unitWeightUnit?: string; isFood?: boolean }) {
    try {
      if (editingIngredient) {
        await updateIngredient(editingIngredient.id, {
          name: data.name, category: data.category, min_qty: data.minQty, unit: data.unit,
          price_per_unit: data.pricePerUnit, waste_percent: data.wastePercent ?? 0,
          unit_weight: data.unitWeight ?? 0, unit_weight_unit: data.unitWeightUnit ?? '', is_food: data.isFood ?? true,
        })
        if (data.initialQty !== undefined && data.initialQty !== editingIngredient.qty) {
          const { api, unwrap } = await import('@/lib/api')
          await unwrap(api.PATCH('/api/v1/stock/ingredients/{id}', {
            params: { path: { id: editingIngredient.id } },
            body: { qty: String(data.initialQty) } as any,
          }))
        }
        toast.success(data.isFood ? 'Ингредиент обновлён' : 'Хозтовар обновлён')
      } else {
        await createIngredient({
          name: data.name, category: data.category, qty: data.initialQty ?? 0, min_qty: data.minQty, unit: data.unit,
          price_per_unit: data.pricePerUnit, waste_percent: data.wastePercent ?? 0,
          unit_weight: data.unitWeight ?? 0, unit_weight_unit: data.unitWeightUnit ?? '', is_food: data.isFood ?? true,
        })
        toast.success('Ингредиент добавлен')
      }
      reloadStock()
    } catch {
      toast.error('Ошибка при сохранении ингредиента')
    }
  }

  function openCreateDialog() { setEditingIngredient(undefined); setDialogOpen(true) }
  function openEditDialog(ing: Ingredient) { setEditingIngredient(ing); setDialogOpen(true) }

  function toggleSelect(id: string) {
    setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  function exitSelect() { setSelectMode(false); setSelectedIds(new Set()) }

  async function deleteOne(ing: Ingredient) {
    if (!window.confirm(`Удалить «${ing.name}»? Остаток будет списан (отразится в Балансе как убыток).`)) return
    try {
      await deleteIngredient(ing.id)
      toast.success('Позиция удалена')
      reloadStock()
    } catch (e) {
      toast.error(humanizeError(e, 'Не удалось удалить (используется в техкартах?)'))
    }
  }

  async function handleBulkDelete() {
    const ids = [...selectedIds]
    if (ids.length === 0) return
    if (!window.confirm(`Удалить ${ids.length} позиц.? У позиций с остатком он будет списан (отразится в Балансе как убыток).`)) return
    setDeleting(true)
    let ok = 0
    const failed: string[] = []
    for (const id of ids) {
      try { await deleteIngredient(id); ok++ }
      catch (e) { failed.push(`${ingredients.find(i => i.id === id)?.name ?? id}: ${humanizeError(e, 'ошибка')}`) }
    }
    setDeleting(false)
    if (ok > 0) toast.success(`Удалено: ${ok}`)
    if (failed.length > 0) toast.error(`Не удалось удалить ${failed.length} (используются в техкартах): ${failed.slice(0, 3).join('; ')}`)
    reloadStock()
    exitSelect()
  }

  if (loading) return <div className="p-6 flex items-center justify-center h-64"><div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>

  const kindOf = (i: Ingredient): WhKind => {
    const k = i.warehouseId ? warehouseById.get(i.warehouseId)?.kind : undefined
    if (k === 'products' || k === 'purchased' || k === 'supplies') return k
    return i.isFood === false ? 'supplies' : 'products'
  }
  const countByKind: Record<WhKind, number> = { products: 0, purchased: 0, supplies: 0 }
  for (const i of ingredients) countByKind[kindOf(i)]++

  const tabItems = ingredients.filter(i => kindOf(i) === whKind)
  const tabCategories = [...new Set(tabItems.map(i => i.category))].sort()
  const lowCount = tabItems.filter(i => i.qty > 0 && i.minQty > 0 && i.qty <= i.minQty).length
  const outCount = tabItems.filter(i => i.qty <= 0).length
  const totalValue = tabItems.reduce((s, i) => s + (i.qty > 0 ? i.qty * i.pricePerUnit : 0), 0)
  // Дубликаты в текущем складе: одинаковое имя (без регистра/пробелов) у 2+
  // позиций. Обычно из двойного импорта (один товар заведён в двух категориях).
  const duplicateGroups = (() => {
    const byName = new Map<string, Ingredient[]>()
    for (const i of tabItems) {
      const key = i.name.trim().toLowerCase()
      const arr = byName.get(key)
      if (arr) arr.push(i)
      else byName.set(key, [i])
    }
    return [...byName.values()].filter(g => g.length > 1).sort((a, b) => a[0].name.localeCompare(b[0].name, 'ru'))
  })()

  const filtered = tabItems.filter((i) => {
    if (!i.name.toLowerCase().includes(search.toLowerCase())) return false
    if (category !== 'all' && i.category !== category) return false
    if (status === 'out' && i.qty > 0) return false
    if (status === 'low' && !(i.qty > 0 && i.minQty > 0 && i.qty <= i.minQty)) return false
    return true
  }).sort((a, b) => a.name.localeCompare(b.name, 'ru'))

  const stateOf = (i: Ingredient) => i.qty <= 0 ? 'out' : (i.minQty > 0 && i.qty <= i.minQty ? 'low' : 'ok')

  // Выгрузка склада в Excel (по текущему складу и фильтрам — то, что на экране).
  // Цена закупки — pricePerUnit (себестоимость единицы). Цена продажи есть
  // только у покупных товаров (это блюда is_purchased): берём её с блюда,
  // матчим по имени — покупной товар и его блюдо ведут одно имя (menu_write.go
  // синхронит name+price_per_unit ингредиента при правке блюда).
  const handleExport = async () => {
    const tabLabel = WH_TABS.find(t => t.kind === whKind)?.label ?? 'Склад'
    const sellByName = new Map<string, number>()
    if (whKind === 'purchased') {
      const items = await fetchMenuItems().catch(() => [])
      for (const mi of items) {
        if (mi.isPurchased) sellByName.set(mi.name.trim().toLowerCase(), mi.price)
      }
    }
    const cols = [
      { key: 'name', header: 'Наименование' },
      { key: 'category', header: 'Категория' },
      { key: 'unit', header: 'Ед.' },
      { key: 'qty', header: 'Остаток' },
      { key: 'minQty', header: 'Мин. остаток' },
      { key: 'buyPrice', header: 'Цена закупки' },
      ...(whKind === 'purchased' ? [{ key: 'sellPrice', header: 'Цена продажи' }] : []),
      { key: 'value', header: 'Стоимость (по закупке)' },
    ]
    exportToExcel(
      filtered.map(i => ({
        name: i.name,
        category: i.category,
        unit: i.unit,
        qty: i.qty,
        minQty: i.minQty,
        buyPrice: i.pricePerUnit,
        sellPrice: sellByName.get(i.name.trim().toLowerCase()) ?? '',
        value: i.qty > 0 ? i.qty * i.pricePerUnit : 0,
      })),
      cols,
      `Склад — ${tabLabel}`,
    )
  }

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">Остатки</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            {tabItems.length} позиций · {formatCurrency(totalValue)}
          </p>
        </div>
        {canManage && (
          selectMode ? (
            <div className="flex items-center gap-2">
              <button onClick={handleBulkDelete} disabled={deleting || selectedIds.size === 0}
                className="flex items-center gap-1.5 bg-destructive text-destructive-foreground px-3 py-2 rounded-lg text-sm font-medium hover:bg-destructive/90 transition-colors disabled:opacity-50">
                <Trash2 className="size-4" />{deleting ? 'Удаление…' : `Удалить${selectedIds.size ? ` (${selectedIds.size})` : ''}`}
              </button>
              <button onClick={exitSelect} disabled={deleting} className="flex items-center gap-1.5 bg-card border border-border px-3 py-2 rounded-lg text-sm font-medium hover:bg-muted transition-colors disabled:opacity-50">
                <X className="size-4" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <button onClick={handleExport} disabled={filtered.length === 0} title="Скачать Excel"
                className="flex items-center justify-center bg-card border border-border text-muted-foreground size-9 rounded-lg hover:bg-muted transition-colors disabled:opacity-40">
                <Download className="size-4" />
              </button>
              {duplicateGroups.length > 0 && (
                <button onClick={() => setDupOpen(true)} title="Найти и убрать дубликаты"
                  className="flex items-center gap-1.5 bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-400 border border-amber-200 dark:border-amber-500/30 px-3 py-2 rounded-lg text-sm font-medium hover:bg-amber-200/70 dark:hover:bg-amber-500/25 transition-colors">
                  <Layers className="size-4" />Дубликаты {duplicateGroups.length}
                </button>
              )}
              <button onClick={() => setSelectMode(true)} title="Выбрать и удалить несколько"
                className="flex items-center justify-center bg-card border border-border text-muted-foreground size-9 rounded-lg hover:bg-muted transition-colors">
                <Trash2 className="size-4" />
              </button>
              <button onClick={() => whKind === 'purchased' ? navigate('/warehouse/menu/new') : openCreateDialog()}
                className="flex items-center gap-1.5 bg-primary text-primary-foreground px-3.5 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors">
                <Plus className="size-4" />Добавить
              </button>
            </div>
          )
        )}
      </div>

      {/* Склады */}
      <div className="flex gap-1 bg-muted rounded-lg p-1 w-fit">
        {WH_TABS.map(t => (
          <button key={t.kind} onClick={() => { setWhKind(t.kind); setCategory('all'); setStatus('all') }}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${whKind === t.kind ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
            {t.label}{countByKind[t.kind] > 0 && <span className="ml-1 text-xs text-muted-foreground">{countByKind[t.kind]}</span>}
          </button>
        ))}
      </div>

      {/* Поиск */}
      <div className="relative">
        <Search className="size-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <input type="text" placeholder="Поиск товара…" value={search} onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-10 pr-4 py-2.5 text-sm bg-card border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/30" />
      </div>

      {/* Статус */}
      <div className="flex gap-2 overflow-x-auto pb-0.5">
        {([['all', 'Все', tabItems.length], ['low', 'Мало', lowCount], ['out', 'Нет', outCount]] as const).map(([k, label, count]) => (
          <button key={k} onClick={() => setStatus(k)}
            className={`whitespace-nowrap text-sm font-medium px-3.5 py-1.5 rounded-full border transition-colors ${
              status === k
                ? (k === 'out' ? 'bg-destructive text-destructive-foreground border-transparent' : k === 'low' ? 'bg-amber-500 text-white border-transparent' : 'bg-primary text-primary-foreground border-transparent')
                : 'bg-card border-border text-muted-foreground hover:bg-muted'
            }`}>
            {label} <span className="opacity-80 tabular-nums">{count}</span>
          </button>
        ))}
      </div>

      {/* Категории */}
      {tabCategories.length > 1 && (
        <div className="flex gap-1.5 overflow-x-auto pb-0.5">
          <button onClick={() => setCategory('all')}
            className={`whitespace-nowrap px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${category === 'all' ? 'bg-foreground/90 text-background border-transparent' : 'bg-card border-border text-muted-foreground hover:bg-muted'}`}>Все категории</button>
          {tabCategories.map(c => (
            <button key={c} onClick={() => setCategory(c)}
              className={`whitespace-nowrap px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${category === c ? 'bg-foreground/90 text-background border-transparent' : 'bg-card border-border text-muted-foreground hover:bg-muted'}`}>{c}</button>
          ))}
        </div>
      )}

      {/* Карточки */}
      {filtered.length === 0 ? (
        <div className="bg-card rounded-xl border border-dashed border-border py-14 text-center text-sm text-muted-foreground">
          {search || category !== 'all' || status !== 'all' ? 'Ничего не найдено' : 'На этом складе пусто'}
        </div>
      ) : (
        <div className="bg-card rounded-xl border border-border overflow-hidden divide-y divide-border">
          {filtered.map(ing => {
            const st = stateOf(ing)
            const sel = selectedIds.has(ing.id)
            const wh = ing.warehouseId ? warehouseById.get(ing.warehouseId) : undefined
            return (
              <button key={ing.id}
                onClick={() => selectMode ? toggleSelect(ing.id) : setActionItem(ing)}
                className={`w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/40 transition-colors ${selectMode && sel ? 'bg-primary/10' : ''}`}>
                {selectMode ? (
                  <span className={`shrink-0 size-5 rounded-md border flex items-center justify-center ${sel ? 'bg-primary border-primary text-primary-foreground' : 'border-border bg-background'}`}>
                    {sel && <Check className="size-3.5" />}
                  </span>
                ) : (
                  <span className={`shrink-0 size-2.5 rounded-full ${st === 'out' ? 'bg-destructive' : st === 'low' ? 'bg-amber-500' : 'bg-emerald-500'}`} />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground truncate">{ing.name}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {ing.category} · {formatCurrency(ing.pricePerUnit)}/{ing.unit}
                    {ing.wastePercent > 0 && <span className="text-amber-600"> · отходы {ing.wastePercent}%</span>}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <div className={`text-sm font-bold tabular-nums ${st === 'out' ? 'text-destructive' : st === 'low' ? 'text-amber-600' : 'text-foreground'}`}>
                    {formatNum(ing.qty)} <span className="text-xs font-normal text-muted-foreground">{ing.unit}</span>
                  </div>
                  <div className="text-xs text-muted-foreground tabular-nums">{formatCurrency(ing.qty > 0 ? ing.qty * ing.pricePerUnit : 0)}</div>
                </div>
                {!selectMode && <ChevronRight className="size-4 text-muted-foreground shrink-0" />}
                {wh && whKind !== 'products' && (
                  <span className="sr-only">{wh.name}</span>
                )}
              </button>
            )
          })}
        </div>
      )}

      {/* Лист действий по позиции */}
      <Dialog open={!!actionItem} onOpenChange={(o) => { if (!o) setActionItem(null) }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{actionItem?.name}</DialogTitle>
          </DialogHeader>
          {actionItem && (
            <>
              <p className="text-sm text-muted-foreground -mt-1">
                Остаток {formatNum(actionItem.qty)} {actionItem.unit} · {formatCurrency(actionItem.pricePerUnit)}/{actionItem.unit}
              </p>
              <div className="space-y-2 mt-1">
                <ActionBtn icon={ShoppingCart} label="Закупить" hint="создать приёмку" onClick={() => { setActionItem(null); navigate('/warehouse/receipts/new') }} />
                {canManage && (
                  <ActionBtn icon={Pencil} label="Править" hint="цена, норма, единица" onClick={() => { const it = actionItem; setActionItem(null); openEditDialog(it) }} />
                )}
                {canManage && warehouses.length > 1 && (
                  <ActionBtn icon={ArrowRightLeft} label="Переместить" hint="на другой склад" onClick={() => { const it = actionItem; setActionItem(null); setMoveTarget(it) }} />
                )}
                <ActionBtn icon={PackageMinus} label="Списать" hint="брак · порча" onClick={() => { setActionItem(null); navigate('/warehouse/writeoffs/new') }} />
                {canManage && (
                  <ActionBtn icon={Trash2} label="Удалить" danger onClick={() => { const it = actionItem; setActionItem(null); deleteOne(it) }} />
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <ManageIngredientDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        ingredient={editingIngredient}
        defaultIsFood={whKind !== 'supplies'}
        onSubmit={handleIngredientSubmit}
      />

      <Dialog open={!!moveTarget} onOpenChange={(o) => { if (!o) setMoveTarget(null) }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Переместить «{moveTarget?.name}»</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground mb-1">Выберите склад назначения:</p>
          <div className="space-y-2">
            {warehouses.map(w => {
              const current = moveTarget?.warehouseId === w.id
              return (
                <button key={w.id} disabled={current || moving} onClick={() => doMove(w.id)}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg border text-sm transition-colors ${current ? 'border-border bg-muted/50 text-muted-foreground cursor-default' : 'border-border hover:bg-muted text-foreground'}`}>
                  <span className="flex items-center gap-2">
                    <span className={`inline-block size-2 rounded-full ${w.kind === 'products' ? 'bg-emerald-500' : w.kind === 'purchased' ? 'bg-blue-500' : 'bg-zinc-400'}`} />
                    {w.name}
                  </span>
                  {current && <span className="text-xs">текущий</span>}
                </button>
              )
            })}
          </div>
        </DialogContent>
      </Dialog>

      {/* Дубликаты — одинаковые названия в текущем складе; лишние удаляем по одному */}
      <Dialog open={dupOpen} onOpenChange={setDupOpen}>
        <DialogContent className="sm:max-w-lg max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Дубликаты · {WH_TABS.find(t => t.kind === whKind)?.label}</DialogTitle>
          </DialogHeader>
          {duplicateGroups.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Дубликатов нет</p>
          ) : (
            <div className="overflow-y-auto flex-1 min-h-0 space-y-3">
              <p className="text-xs text-muted-foreground">
                Одинаковые названия — обычно из двойного импорта. Оставь нужную позицию, лишние удали (у покупных удалится и блюдо; остаток спишется).
              </p>
              {duplicateGroups.map(group => (
                <div key={group[0].name.trim().toLowerCase()} className="border border-border rounded-xl overflow-hidden">
                  <div className="px-3 py-2 bg-muted/40 text-sm font-semibold text-foreground flex items-center justify-between gap-2">
                    <span className="truncate">{group[0].name}</span>
                    <span className="text-xs text-muted-foreground shrink-0">{group.length} шт.</span>
                  </div>
                  <div className="divide-y divide-border">
                    {group.map(ing => (
                      <div key={ing.id} className="flex items-center gap-3 px-3 py-2">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-foreground truncate">{ing.category || 'Без категории'}</p>
                          <p className="text-[11px] text-muted-foreground">{formatNum(ing.qty)} {ing.unit} · {formatCurrency(ing.pricePerUnit)}/{ing.unit}</p>
                        </div>
                        <button onClick={() => deleteOne(ing)}
                          className="flex items-center gap-1 text-xs font-medium text-destructive border border-destructive/30 rounded-md px-2.5 py-1.5 hover:bg-destructive/10 transition-colors shrink-0">
                          <Trash2 className="size-3.5" />Удалить
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

// Кнопка в листе действий по позиции.
function ActionBtn({ icon: Icon, label, hint, danger, onClick }: { icon: typeof ShoppingCart; label: string; hint?: string; danger?: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors ${danger ? 'border-destructive/30 text-destructive hover:bg-destructive/10' : 'border-border text-foreground hover:bg-muted'}`}>
      <span className={`size-8 rounded-lg flex items-center justify-center shrink-0 ${danger ? 'bg-destructive/10' : 'bg-primary/10 text-primary'}`}>
        <Icon className="size-4" />
      </span>
      <span className="text-sm font-medium">{label}</span>
      {hint && <span className="text-xs text-muted-foreground ml-auto">{hint}</span>}
    </button>
  )
}
