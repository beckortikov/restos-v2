'use client'

import { useState, useEffect } from 'react'
import { useAuth } from '@/lib/auth-store'
import { formatCurrency, formatNum } from '@/lib/helpers'
import { dDiv, dMul, dRound, dSub } from '@/lib/decimal'
import { type MenuItem, type MenuStation, STATION_LABELS, STATION_ICONS, ALL_STATIONS } from '@/lib/types'
import { fetchMenuItems, createMenuItem as createMenuItemDb, updateMenuItem, toggleMenuAvailability, fetchMenuCategories, fetchMenuCategoriesFull, createMenuCategory, deleteMenuCategory, deleteMenuItem, archiveMenuItem, fetchStopList, toggleStopListOverride, createIngredient } from '@/lib/queries'
import { type MenuCategory } from '@/lib/queries'
import { Search, ChevronDown, ChevronRight, BookOpen, Pencil, OctagonX, ShieldCheck, Plus, X } from 'lucide-react'
import { CreateMenuItemDialog } from '@/components/dialogs/create-menu-item-dialog'
import { EditMenuItemDialog } from '@/components/dialogs/edit-menu-item-dialog'
import { DishImage } from '@/components/dish-image'
import { toast } from 'sonner'

export default function MenuPage() {
  const { canDo } = useAuth()
  const canSeeFinancials = canDo('menu.view_cost')
  const canEdit = canDo('menu.edit')
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('all')
  const [station, setStation] = useState<'all' | MenuStation>('all')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editDialogOpen, setEditDialogOpen] = useState(false)
  const [editingItem, setEditingItem] = useState<MenuItem | null>(null)
  const [menuItems, setMenuItems] = useState<MenuItem[]>([])
  const [menuCategories, setMenuCategories] = useState<string[]>([])
  const [menuCategoriesFull, setMenuCategoriesFull] = useState<MenuCategory[]>([])
  const [addCatOpen, setAddCatOpen] = useState(false)
  const [newCatName, setNewCatName] = useState('')
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'menu' | 'stoplist'>('menu')
  const [stopList, setStopList] = useState<{ menuItemId: string; menuItemName: string; emoji: string; category: string; ingredients: { name: string; qty: number; minQty: number; unit: string }[] }[]>([])

  const reloadAll = async () => {
    // Load independently — if one fails, others still work
    fetchMenuItems().then(setMenuItems).catch(() => {})
    fetchMenuCategories().then(setMenuCategories).catch(() => {})
    fetchMenuCategoriesFull().then(setMenuCategoriesFull).catch(() => {})
    fetchStopList().then(setStopList).catch(() => {})
  }

  useEffect(() => {
    reloadAll().finally(() => setLoading(false))
  }, [])

  async function handleCreateMenuItem(data: { name: string; category: string; price: number; emoji: string; cogs: number; isAvailable: boolean; isPurchased?: boolean; purchasePrice?: number; purchaseUnit?: string; purchaseMinQty?: number; isBatchCooking?: boolean; lowStockThreshold?: number; unit?: 'piece' | 'g' | 'kg'; unitSize?: number; saleStep?: number; techCard: { name: string; qty: number; unit: string; ingredientId?: string; semiId?: string }[] }) {
    try {
      let finalData = { ...data }

      // Purchased item: auto-create ingredient + set tech card
      if (data.isPurchased && data.purchasePrice && data.purchaseUnit) {
        const ing = await createIngredient({
          name: data.name,
          category: data.category,
          qty: 0,
          min_qty: data.purchaseMinQty ?? 0,
          unit: data.purchaseUnit,
          price_per_unit: data.purchasePrice,
        })
        if (ing) {
          finalData = {
            ...data,
            cogs: data.purchasePrice,
            techCard: [{ name: data.name, qty: 1, unit: data.purchaseUnit, ingredientId: ing.id }],
          }
        }
      }

      await createMenuItemDb({
        ...finalData,
        stopListOverride: false,
        station: 'hot_kitchen',
        preparedQty: 0,
        isBatchCooking: finalData.isBatchCooking ?? false,
      })
      await reloadAll()
      toast.success(data.isPurchased ? 'Покупной товар добавлен' : 'Блюдо добавлено')
    } catch {
      toast.error('Ошибка при добавлении')
    }
  }

  function openEditDialog(item: MenuItem) {
    setEditingItem(item)
    setEditDialogOpen(true)
  }

  async function handleEditSubmit(data: { name: string; category: string; price: number; emoji: string; cogs: number; isAvailable: boolean; isBatchCooking?: boolean; lowStockThreshold?: number; techCard: { name: string; qty: number; unit: string; ingredientId?: string; semiId?: string }[] }) {
    if (!editingItem) return
    try {
      await updateMenuItem(editingItem.id, data)
      toast.success('Блюдо обновлено')
      await reloadAll()
    } catch {
      toast.error('Ошибка при обновлении')
    }
  }

  async function handleDeleteMenuItem(id: string) {
    try {
      await deleteMenuItem(id)
      const updated = await fetchMenuItems()
      setMenuItems(updated)
      toast.success('Блюдо удалено')
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Ошибка при удалении блюда'
      toast.error(msg)
    }
  }

  async function handleArchiveMenuItem(id: string) {
    try {
      await archiveMenuItem(id)
      const updated = await fetchMenuItems()
      setMenuItems(updated)
      toast.success('Блюдо отправлено в архив')
    } catch {
      toast.error('Ошибка при архивировании блюда')
    }
  }

  async function handleToggleAvailability(id: string) {
    const item = menuItems.find((m) => m.id === id)
    if (!item) return
    const newVal = !item.isAvailable
    setMenuItems((prev) => prev.map((m) => m.id === id ? { ...m, isAvailable: newVal } : m))
    try {
      await toggleMenuAvailability(id, newVal)
    } catch {
      // revert on error
      setMenuItems((prev) => prev.map((m) => m.id === id ? { ...m, isAvailable: !newVal } : m))
    }
  }

  if (loading) return <div className="p-6 flex items-center justify-center h-64"><div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>

  const filtered = menuItems.filter((m) => {
    const matchSearch = m.name.toLowerCase().includes(search.toLowerCase())
    const matchCat = category === 'all' || m.category === category
    const matchStation = station === 'all' || m.station === station
    return matchSearch && matchCat && matchStation
  })

  // Per-station counters for the station tab badges.
  const stationCounts: Record<MenuStation | 'all', number> = {
    all: menuItems.length,
    hot_kitchen: 0, cold_kitchen: 0, grill: 0, bar: 0, showcase: 0,
  }
  for (const m of menuItems) stationCounts[m.station] = (stationCounts[m.station] ?? 0) + 1

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6 space-y-4 md:space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">Меню и техкарты</h1>
          <p className="text-muted-foreground text-sm mt-0.5">{menuItems.length} позиций{stopList.length > 0 ? ` · ${stopList.length} в стоп-листе` : ''}</p>
        </div>
        {canEdit && (
          <button
            onClick={() => setDialogOpen(true)}
            className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors w-full sm:w-auto justify-center"
          >
            + Добавить блюдо
          </button>
        )}
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 bg-muted/50 p-1 rounded-xl w-fit">
        <button
          onClick={() => setTab('menu')}
          className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium transition-colors ${tab === 'menu' ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
        >
          <BookOpen className="size-3.5" />Меню
          <span className="bg-muted px-1.5 py-0.5 rounded text-[10px] font-bold">{menuItems.length}</span>
        </button>
        <button
          onClick={() => setTab('stoplist')}
          className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium transition-colors ${tab === 'stoplist' ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
        >
          <OctagonX className="size-3.5" />Стоп-лист
          {stopList.length > 0 && (
            <span className="bg-destructive/10 text-destructive px-1.5 py-0.5 rounded text-[10px] font-bold">{stopList.length}</span>
          )}
        </button>
      </div>

      {tab === 'stoplist' ? (
        /* Stop-list view */
        <div className="space-y-3">
          {stopList.length === 0 ? (
            <div className="bg-card rounded-xl border border-border p-8 text-center">
              <ShieldCheck className="size-10 text-emerald-500/40 mx-auto mb-3" />
              <p className="font-medium text-foreground">Стоп-лист пуст</p>
              <p className="text-sm text-muted-foreground mt-1">Все ингредиенты в наличии</p>
            </div>
          ) : (
            stopList.map(item => {
              const menuItem = menuItems.find(m => m.id === item.menuItemId)
              const isOverridden = menuItem?.stopListOverride ?? false
              return (
                <div key={item.menuItemId} className={`bg-card rounded-xl border-2 p-4 ${isOverridden ? 'border-amber-300/50' : 'border-destructive/30'}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-foreground">{item.menuItemName}</span>
                        <span className="text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded">{item.category}</span>
                        {isOverridden && (
                          <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded font-medium">Override</span>
                        )}
                      </div>
                      <div className="mt-2 space-y-1">
                        {item.ingredients.map((ing, idx) => (
                          <div key={idx} className="flex items-center gap-2 text-sm">
                            <OctagonX className="size-3 text-destructive shrink-0" />
                            <span className="text-foreground">{ing.name}</span>
                            <span className="text-destructive font-medium">{formatNum(ing.qty)} {ing.unit}</span>
                            <span className="text-xs text-muted-foreground">(мин. {ing.minQty})</span>
                          </div>
                        ))}
                      </div>
                    </div>
                    {canEdit && (
                      <button
                        onClick={async () => {
                          await toggleStopListOverride(item.menuItemId, !isOverridden)
                          await reloadAll()
                          toast.success(isOverridden ? 'Override снят' : 'Блюдо принудительно включено')
                        }}
                        className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors shrink-0 ${
                          isOverridden
                            ? 'bg-destructive/10 text-destructive border-destructive/30 hover:bg-destructive/20'
                            : 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100'
                        }`}
                      >
                        {isOverridden ? 'Вернуть в стоп' : 'Включить'}
                      </button>
                    )}
                  </div>
                </div>
              )
            })
          )}
        </div>
      ) : (
      <>
      {/* Station tabs — крупные пилюли с иконкой и счётчиком. */}
      <div className="flex flex-wrap gap-1.5 items-center bg-muted/30 p-1.5 rounded-2xl">
        <button
          onClick={() => setStation('all')}
          className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-medium transition-all ${
            station === 'all'
              ? 'bg-card text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <span>Все</span>
          <span className="bg-muted px-1.5 py-0.5 rounded-md text-[10px] font-bold tabular-nums">{stationCounts.all}</span>
        </button>
        {ALL_STATIONS.map(s => {
          const count = stationCounts[s] || 0
          const active = station === s
          return (
            <button
              key={s}
              onClick={() => setStation(s)}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-medium transition-all ${
                active
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <span className="text-base leading-none">{STATION_ICONS[s]}</span>
              <span>{STATION_LABELS[s]}</span>
              <span className={`px-1.5 py-0.5 rounded-md text-[10px] font-bold tabular-nums ${active ? 'bg-primary/10 text-primary' : 'bg-muted'}`}>{count}</span>
            </button>
          )
        })}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="relative">
          <Search className="size-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Поиск блюда..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 pr-4 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 w-52"
          />
        </div>
        <div className="flex flex-wrap gap-1.5 items-center">
          <button
            onClick={() => setCategory('all')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${category === 'all' ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border text-foreground hover:bg-muted'}`}
          >
            Все
          </button>
          {menuCategories.map((c) => {
            const catObj = menuCategoriesFull.find(mc => mc.name === c)
            return (
              <div key={c} className="relative group">
                <button
                  onClick={() => setCategory(c)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${category === c ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border text-foreground hover:bg-muted'}`}
                >
                  {c}
                </button>
                {canEdit && catObj && (
                  <button
                    onClick={async (e) => {
                      e.stopPropagation()
                      if (!window.confirm(`Удалить категорию «${c}»?`)) return
                      try {
                        await deleteMenuCategory(catObj.id)
                        setMenuCategoriesFull(prev => prev.filter(mc => mc.id !== catObj.id))
                        setMenuCategories(prev => prev.filter(mc => mc !== c))
                        if (category === c) setCategory('all')
                        toast.success(`Категория «${c}» удалена`)
                      } catch { toast.error('Ошибка удаления') }
                    }}
                    className="absolute -top-1.5 -right-1.5 size-5 bg-red-500 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-red-600 shadow-sm transition-all"
                    aria-label="Удалить категорию"
                  >
                    <X className="size-2.5" />
                  </button>
                )}
              </div>
            )
          })}
          {canEdit && (
            addCatOpen ? (
              <div className="flex items-center gap-1">
                <input
                  autoFocus
                  type="text"
                  value={newCatName}
                  onChange={e => setNewCatName(e.target.value)}
                  onKeyDown={async (e) => {
                    if (e.key === 'Enter' && newCatName.trim()) {
                      try {
                        const cat = await createMenuCategory(newCatName.trim())
                        setMenuCategoriesFull(prev => [...prev, cat])
                        setMenuCategories(prev => [...prev, cat.name].sort())
                        setNewCatName('')
                        setAddCatOpen(false)
                        toast.success(`Категория «${cat.name}» создана`)
                      } catch (err) { toast.error(err instanceof Error ? err.message : 'Ошибка создания') }
                    }
                    if (e.key === 'Escape') { setAddCatOpen(false); setNewCatName('') }
                  }}
                  placeholder="Название..."
                  className="px-2 py-1 text-xs bg-card border border-primary rounded-lg focus:outline-none w-28"
                />
                <button onClick={() => { setAddCatOpen(false); setNewCatName('') }} className="text-muted-foreground hover:text-foreground">
                  <X className="size-3.5" />
                </button>
              </div>
            ) : (
              <button
                onClick={() => setAddCatOpen(true)}
                className="px-2 py-1.5 rounded-lg text-xs font-medium border border-dashed border-primary/40 text-primary hover:bg-primary/5 transition-colors flex items-center gap-1"
              >
                <Plus className="size-3" />
              </button>
            )
          )}
        </div>
      </div>

      {/* Card Grid view for waiter/cook/cashier */}
      {!canSeeFinancials && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
          {filtered.map((item) => (
            <div
              key={item.id}
              className={`relative bg-card rounded-xl border border-border overflow-hidden transition-all hover:shadow-md ${!item.isAvailable ? 'opacity-50' : ''}`}
            >
              {/* Image / Emoji */}
              <div className="aspect-square bg-muted/30 flex items-center justify-center overflow-hidden">
                <DishImage imageUrl={item.imageUrl} emoji={item.emoji} name={item.name} size="fill" />
              </div>

              {/* Info */}
              <div className="p-3">
                <p className="font-semibold text-foreground text-sm truncate">{item.name}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {item.category}{item.cookTimeMin ? ` · ⏱ ${item.cookTimeMin} мин` : ''}
                  {item.station === 'bar' && <span className="ml-1 text-blue-600">· ☕ Бар</span>}
                  {item.station === 'showcase' && <span className="ml-1 text-amber-600">· 🥟 Витрина</span>}
                </p>
                <div className="flex items-center justify-between mt-2">
                  <p className="text-base font-bold text-primary">{formatCurrency(item.price)}</p>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${item.isAvailable ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                    {item.isAvailable ? 'В наличии' : 'СТОП'}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* List view for manager/accountant/storekeeper/owner */}
      {canSeeFinancials && (
        <div className="bg-card rounded-xl border border-border overflow-hidden divide-y divide-border">
          {filtered.map((item) => (
            <div key={item.id}>
              <div
                onClick={() => setExpanded(expanded === item.id ? null : item.id)}
                className="flex items-center justify-between px-4 py-3.5 hover:bg-muted/30 cursor-pointer transition-colors"
              >
                <div className="flex items-center gap-3">
                  <DishImage imageUrl={item.imageUrl} emoji={item.emoji} name={item.name} size="sm" />
                  <div>
                    <p className="font-medium text-foreground text-sm">{item.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {item.category} · {item.techCard.length} ингр.{item.cookTimeMin ? ` · ⏱ ${item.cookTimeMin} мин` : ''}
                      {item.isBatchCooking && <span className="ml-1 px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded text-[10px] font-medium">Заготовка · {item.preparedQty} порц.</span>}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <p className="text-sm font-semibold text-foreground">{formatCurrency(item.price)}</p>
                    <p className="text-xs text-muted-foreground">с/с: {formatCurrency(item.cogs)} ({item.price > 0 ? dRound(dMul(dDiv(item.cogs, item.price), 100), 0) : 0}%)</p>
                  </div>
                  {canEdit ? (
                    <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                      <span className={`text-xs font-medium ${item.isAvailable ? 'text-emerald-600' : 'text-destructive'}`}>
                        {item.isAvailable ? 'В наличии' : 'СТОП'}
                      </span>
                      <button
                        onClick={() => handleToggleAvailability(item.id)}
                        className={`relative w-10 h-[22px] rounded-full transition-colors duration-200 ${
                          item.isAvailable ? 'bg-emerald-500' : 'bg-muted-foreground/30'
                        }`}
                      >
                        <span className={`absolute top-[2px] left-[2px] size-[18px] bg-white rounded-full shadow-sm transition-transform duration-200 ${
                          item.isAvailable ? 'translate-x-[18px]' : 'translate-x-0'
                        }`} />
                      </button>
                    </div>
                  ) : (
                    <span className={`text-xs px-2 py-0.5 rounded font-medium ${item.isAvailable ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                      {item.isAvailable ? 'В наличии' : 'СТОП'}
                    </span>
                  )}
                  {expanded === item.id ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}
                </div>
              </div>

              {/* Техкарта */}
              {expanded === item.id && (
                <div className="px-6 py-4 bg-muted/20 border-t border-border">
                  <div className="flex items-center gap-2 mb-3">
                    <BookOpen className="size-4 text-primary" />
                    <p className="text-sm font-semibold text-foreground">Техкарта: {item.name}</p>
                  </div>
                  <div className="space-y-1.5 max-w-sm">
                    {item.techCard.map((line, i) => (
                      <div key={i} className="flex items-center justify-between text-sm">
                        <div className="flex items-center gap-2">
                          <div className={`size-1.5 rounded-full ${line.semiId ? 'bg-primary' : 'bg-muted-foreground'}`} />
                          <span className="text-foreground">{line.name}</span>
                          {line.semiId && <span className="text-xs bg-primary/10 text-primary px-1.5 rounded">п/ф</span>}
                        </div>
                        <span className="text-muted-foreground">{formatNum(line.qty)} {line.unit}</span>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 pt-3 border-t border-border flex flex-wrap items-center gap-6 text-xs">
                    <span className="text-muted-foreground">Цена продажи: <span className="font-semibold text-foreground">{formatCurrency(item.price)}</span></span>
                    <span className="text-muted-foreground">Себестоимость: <span className="font-semibold text-foreground">{formatCurrency(item.cogs)}</span></span>
                    <span className="text-muted-foreground">Маржа: <span className="font-semibold text-emerald-600">{item.price > 0 ? dRound(dMul(dDiv(dSub(item.price, item.cogs), item.price), 100), 0) : 0}%</span></span>
                    {canEdit && (
                      <button
                        onClick={(e) => { e.stopPropagation(); openEditDialog(item) }}
                        className="flex items-center gap-1 ml-auto text-xs text-primary hover:underline"
                      >
                        <Pencil className="size-3" />
                        Редактировать
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <CreateMenuItemDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSubmit={handleCreateMenuItem}
      />

      {editingItem && (
        <EditMenuItemDialog
          open={editDialogOpen}
          onOpenChange={setEditDialogOpen}
          menuItem={editingItem}
          onSubmit={handleEditSubmit}
          onDelete={handleDeleteMenuItem}
          onArchive={handleArchiveMenuItem}
        />
      )}
      </>
      )}
    </div>
  )
}
