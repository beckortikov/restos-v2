'use client'

import { useState, useEffect } from 'react'
import { fetchAllRestaurants, fetchAllUsers, createRestaurant, createUserForRestaurant } from '@/lib/queries'
import type { Restaurant, User } from '@/lib/types'
import { toast } from 'sonner'
import { Link } from 'react-router-dom'
import { Plus, Building2, Search, Monitor, ShieldOff } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'

export default function AdminRestaurantsPage() {
  const [restaurants, setRestaurants] = useState<Restaurant[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)

  // New restaurant form
  const [formName, setFormName] = useState('')
  const [formSlug, setFormSlug] = useState('')
  const [formAddress, setFormAddress] = useState('')
  const [formPhone, setFormPhone] = useState('')
  const [ownerName, setOwnerName] = useState('')
  const [ownerUsername, setOwnerUsername] = useState('')
  const [ownerPassword, setOwnerPassword] = useState('1234')
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    Promise.all([fetchAllRestaurants(), fetchAllUsers()])
      .then(([r, u]) => { setRestaurants(r); setUsers(u) })
      .finally(() => setLoading(false))
  }, [])

  const filtered = restaurants.filter(r =>
    r.name.toLowerCase().includes(search.toLowerCase()) ||
    r.slug.toLowerCase().includes(search.toLowerCase())
  )

  function onlineStatus(lastSeen?: string) {
    if (!lastSeen) return { color: 'bg-gray-300', label: 'Нет данных' }
    const diff = Date.now() - new Date(lastSeen).getTime()
    if (diff < 3 * 60 * 1000) return { color: 'bg-emerald-500', label: 'Онлайн' }
    if (diff < 10 * 60 * 1000) return { color: 'bg-yellow-500', label: 'Недавно' }
    return { color: 'bg-gray-300', label: 'Оффлайн' }
  }

  const handleCreate = async () => {
    if (!formName || !formSlug || !ownerName || !ownerUsername) return
    setCreating(true)
    try {
      const rest = await createRestaurant({
        name: formName,
        slug: formSlug.toLowerCase().replace(/\s+/g, '-'),
        address: formAddress,
        phone: formPhone,
      })

      await createUserForRestaurant({
        username: ownerUsername.toLowerCase().trim(),
        name: ownerName,
        role: 'owner',
        restaurantId: rest.id,
        password: ownerPassword || '1234',
      })

      setRestaurants(prev => [rest, ...prev])
      setDialogOpen(false)
      setFormName(''); setFormSlug(''); setFormAddress(''); setFormPhone('')
      setOwnerName(''); setOwnerUsername('')
      toast.success(`Ресторан "${rest.name}" создан`)

      // Refetch users
      fetchAllUsers().then(setUsers)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Ошибка'
      toast.error(msg)
    } finally {
      setCreating(false)
    }
  }

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-64">
        <div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="p-6 space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">Рестораны</h1>
          <p className="text-muted-foreground text-sm mt-0.5">{restaurants.length} зарегистрировано</p>
        </div>
        <button
          onClick={() => setDialogOpen(true)}
          className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          <Plus className="size-4" />
          Новый ресторан
        </button>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Поиск по названию..."
          className="w-full pl-10 pr-4 py-2.5 bg-card border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
      </div>

      {/* List */}
      <div className="bg-card rounded-xl border border-border divide-y divide-border">
        {filtered.map((r) => {
          const restUsers = users.filter(u => u.restaurantId === r.id)
          const owner = restUsers.find(u => u.role === 'owner')
          return (
            <Link
              key={r.id}
              to={`/admin/restaurants/${r.id}`}
              className="flex items-center justify-between px-5 py-4 hover:bg-muted/30 transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className="size-10 rounded-lg bg-primary/10 flex items-center justify-center">
                  <Building2 className="size-5 text-primary" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-foreground">{r.name}</p>
                  <p className="text-xs text-muted-foreground">{r.slug} · {r.address || '—'}</p>
                  {r.licenseKey && (
                    <p className="text-[10px] font-mono text-blue-600 mt-0.5">Ключ: {r.licenseKey}</p>
                  )}
                </div>
              </div>
              <div className="text-right shrink-0 flex flex-col items-end gap-1">
                <p className="text-sm font-medium text-foreground">{restUsers.length} чел.</p>
                <p className="text-xs text-muted-foreground">{owner?.name || 'Нет владельца'}</p>
                {r.lastSeenAt && (
                  <div className="flex items-center gap-1.5">
                    <span className={`size-2 rounded-full ${onlineStatus(r.lastSeenAt).color}`} />
                    <span className="text-[10px] text-muted-foreground">{onlineStatus(r.lastSeenAt).label}</span>
                    {r.appVersion && <span className="text-[10px] text-blue-600">v{r.appVersion}</span>}
                  </div>
                )}
                {r.isBlocked && (
                  <span className="text-[10px] px-1.5 py-0.5 bg-red-100 text-red-700 rounded font-medium">Заблокирован</span>
                )}
                {r.localServerIp && <p className="text-[10px] text-emerald-600">IP: {r.localServerIp}</p>}
              </div>
            </Link>
          )
        })}
        {filtered.length === 0 && (
          <div className="px-5 py-8 text-center text-muted-foreground text-sm">
            {search ? 'Ничего не найдено' : 'Нет ресторанов'}
          </div>
        )}
      </div>

      {/* Create dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Новый ресторан</DialogTitle>
            <DialogDescription>Создайте ресторан и его первого владельца</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Ресторан</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-foreground block mb-1">Название *</label>
                <input value={formName} onChange={e => setFormName(e.target.value)} placeholder="Дастархан" className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm" />
              </div>
              <div>
                <label className="text-xs font-medium text-foreground block mb-1">Slug *</label>
                <input value={formSlug} onChange={e => setFormSlug(e.target.value)} placeholder="dastarkhan" className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-foreground block mb-1">Адрес</label>
                <input value={formAddress} onChange={e => setFormAddress(e.target.value)} placeholder="Душанбе" className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm" />
              </div>
              <div>
                <label className="text-xs font-medium text-foreground block mb-1">Телефон</label>
                <input value={formPhone} onChange={e => setFormPhone(e.target.value.replace(/[^\d+\-\s()]/g, ''))} placeholder="+992 ..." inputMode="tel" className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm" />
              </div>
            </div>

            <div className="border-t border-border pt-4">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Владелец</h3>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-foreground block mb-1">ФИО *</label>
                  <input value={ownerName} onChange={e => setOwnerName(e.target.value)} placeholder="Иван Иванов" className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm" />
                </div>
                <div>
                  <label className="text-xs font-medium text-foreground block mb-1">Логин *</label>
                  <input value={ownerUsername} onChange={e => setOwnerUsername(e.target.value)} placeholder="ivan" className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm" />
                </div>
                <div>
                  <label className="text-xs font-medium text-foreground block mb-1">Пароль *</label>
                  <input value={ownerPassword} onChange={e => setOwnerPassword(e.target.value)} placeholder="1234" className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm" />
                </div>
              </div>
            </div>
          </div>

          <DialogFooter>
            <button
              onClick={handleCreate}
              disabled={creating || !formName || !formSlug || !ownerName || !ownerUsername}
              className="w-full rounded-xl bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {creating ? 'Создание...' : 'Создать ресторан'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
