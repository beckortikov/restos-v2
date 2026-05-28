'use client'

import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { fetchRestaurantById, fetchUsersByRestaurant, getRestaurantStats, createUserForRestaurant, deleteUser, updateRestaurant, seedRestaurantData, deleteRestaurant, updateUser, clearRestaurantOperations } from '@/lib/queries'
import { formatCurrency } from '@/lib/helpers'
import { ROLE_LABELS, type Restaurant, type User, type UserRole } from '@/lib/types'
import { toast } from 'sonner'
import { Link } from 'react-router-dom'
import {
  ArrowLeft, Building2, Users, ShoppingBag, TrendingUp,
  Plus, Trash2, Save, Monitor, ShieldOff, ShieldCheck, Wifi, WifiOff,
  Key, CalendarClock, RefreshCw, Database,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'

const AVAILABLE_ROLES: { value: UserRole; label: string }[] = [
  { value: 'owner', label: 'Владелец' },
  { value: 'manager', label: 'Управляющий' },
  { value: 'waiter', label: 'Официант' },
  { value: 'cashier', label: 'Кассир' },
  { value: 'cook', label: 'Повар' },
  { value: 'storekeeper', label: 'Кладовщик' },
  { value: 'accountant', label: 'Бухгалтер' },
]

export default function RestaurantDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [restaurant, setRestaurant] = useState<Restaurant | null>(null)
  const [users, setUsers] = useState<User[]>([])
  const [stats, setStats] = useState({ usersCount: 0, ordersCount: 0, totalRevenue: 0 })
  const [loading, setLoading] = useState(true)

  // Edit form
  const [editName, setEditName] = useState('')
  const [editAddress, setEditAddress] = useState('')
  const [editPhone, setEditPhone] = useState('')
  const [editService, setEditService] = useState(10)
  const [saving, setSaving] = useState(false)

  // Block/unblock
  const [blockReason, setBlockReason] = useState('')
  const [blocking, setBlocking] = useState(false)

  // Delete restaurant dialog
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteConfirmName, setDeleteConfirmName] = useState('')
  const [deleting, setDeleting] = useState(false)

  // Clear-operations dialog state
  const [clearOpsOpen, setClearOpsOpen] = useState(false)
  const [clearOpsConfirm, setClearOpsConfirm] = useState('')
  const [clearingOps, setClearingOps] = useState(false)

  // Add user dialog
  const [addUserOpen, setAddUserOpen] = useState(false)

  // Password reset dialog
  const [passwordUser, setPasswordUser] = useState<User | null>(null)
  const [newPassword, setNewPassword] = useState('')
  const [savingPassword, setSavingPassword] = useState(false)
  const [newUserName, setNewUserName] = useState('')
  const [newUserUsername, setNewUserUsername] = useState('')
  const [newUserRole, setNewUserRole] = useState<UserRole>('waiter')
  const [newUserSalary, setNewUserSalary] = useState(0)

  useEffect(() => {
    if (!id) { setLoading(false); return }
    Promise.all([
      fetchRestaurantById(id),
      fetchUsersByRestaurant(id),
      getRestaurantStats(id),
    ])
      .then(([r, u, s]) => {
        setRestaurant(r)
        setUsers(u)
        setStats(s)
        if (r) {
          setEditName(r.name)
          setEditAddress(r.address || '')
          setEditPhone(r.phone || '')
          setEditService(r.servicePercent)
        }
      })
      .finally(() => setLoading(false))
  }, [id])

  const handleSave = async () => {
    if (!restaurant) return
    setSaving(true)
    try {
      await updateRestaurant(restaurant.id, {
        name: editName,
        address: editAddress,
        phone: editPhone,
        servicePercent: editService,
      })
      setRestaurant({ ...restaurant, name: editName, address: editAddress, phone: editPhone, servicePercent: editService })
      toast.success('Сохранено')
    } catch { toast.error('Ошибка') }
    finally { setSaving(false) }
  }

  const handleAddUser = async () => {
    if (!newUserName || !newUserUsername || !id) return
    try {
      const user = await createUserForRestaurant({
        username: newUserUsername.toLowerCase().trim(),
        name: newUserName,
        role: newUserRole,
        restaurantId: id,
        salary: newUserSalary,
      })
      setUsers(prev => [...prev, user])
      setAddUserOpen(false)
      setNewUserName(''); setNewUserUsername(''); setNewUserRole('waiter'); setNewUserSalary(0)
      toast.success(`${user.name} добавлен`)
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Ошибка')
    }
  }

  const handleBlock = async () => {
    if (!restaurant) return
    setBlocking(true)
    try {
      await updateRestaurant(restaurant.id, { isBlocked: true, blockReason: blockReason || 'Заблокировано администратором' })
      setRestaurant({ ...restaurant, isBlocked: true, blockReason: blockReason || 'Заблокировано администратором' })
      toast.success('Ресторан заблокирован')
      setBlockReason('')
    } catch { toast.error('Ошибка') }
    finally { setBlocking(false) }
  }

  const handleUnblock = async () => {
    if (!restaurant) return
    setBlocking(true)
    try {
      await updateRestaurant(restaurant.id, { isBlocked: false, blockReason: '' })
      setRestaurant({ ...restaurant, isBlocked: false, blockReason: undefined })
      toast.success('Ресторан разблокирован')
    } catch { toast.error('Ошибка') }
    finally { setBlocking(false) }
  }

  function getOnlineInfo(lastSeen?: string) {
    if (!lastSeen) return { online: false, color: 'text-gray-400', label: 'Нет данных', icon: WifiOff }
    const diff = Date.now() - new Date(lastSeen).getTime()
    if (diff < 3 * 60 * 1000) return { online: true, color: 'text-emerald-500', label: 'Онлайн', icon: Wifi }
    if (diff < 10 * 60 * 1000) return { online: false, color: 'text-yellow-500', label: 'Был ' + timeAgo(lastSeen), icon: Wifi }
    return { online: false, color: 'text-gray-400', label: 'Был ' + timeAgo(lastSeen), icon: WifiOff }
  }

  function timeAgo(date: string) {
    const diff = Date.now() - new Date(date).getTime()
    const mins = Math.floor(diff / 60000)
    if (mins < 60) return `${mins} мин. назад`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `${hours} ч. назад`
    return `${Math.floor(hours / 24)} дн. назад`
  }

  // License management
  const [licenseMonths, setLicenseMonths] = useState(1)
  const [licenseDate, setLicenseDate] = useState('')
  const [renewLoading, setRenewLoading] = useState(false)

  function getLicenseStatus() {
    if (!restaurant?.licenseExpiresAt) return { label: 'Бессрочная', color: 'text-emerald-600', expired: false }
    const expires = new Date(restaurant.licenseExpiresAt)
    const now = new Date()
    const daysLeft = Math.ceil((expires.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    if (daysLeft < 0) return { label: `Истекла ${Math.abs(daysLeft)} дн. назад`, color: 'text-red-600', expired: true }
    if (daysLeft <= 7) return { label: `${daysLeft} дн. осталось`, color: 'text-amber-600', expired: false }
    if (daysLeft <= 30) return { label: `${daysLeft} дн. осталось`, color: 'text-yellow-600', expired: false }
    return { label: `до ${expires.toLocaleDateString('ru')}`, color: 'text-emerald-600', expired: false }
  }

  const handleRenewLicense = async () => {
    if (!restaurant) return
    setRenewLoading(true)
    try {
      const now = new Date()
      // If expired, extend from today; if active, extend from current expiry
      const base = restaurant.licenseExpiresAt && new Date(restaurant.licenseExpiresAt) > now
        ? new Date(restaurant.licenseExpiresAt)
        : now
      const newExpiry = new Date(base)
      newExpiry.setMonth(newExpiry.getMonth() + licenseMonths)
      await updateRestaurant(restaurant.id, {
        licenseExpiresAt: newExpiry.toISOString(),
        isBlocked: false,
        blockReason: '',
      })
      setRestaurant({ ...restaurant, licenseExpiresAt: newExpiry.toISOString(), isBlocked: false, blockReason: undefined })
      toast.success(`Лицензия продлена до ${newExpiry.toLocaleDateString('ru')}`)
    } catch { toast.error('Ошибка') }
    finally { setRenewLoading(false) }
  }

  const handleSetLicenseDate = async () => {
    if (!restaurant || !licenseDate) return
    setRenewLoading(true)
    try {
      const expiry = new Date(licenseDate + 'T23:59:59').toISOString()
      await updateRestaurant(restaurant.id, { licenseExpiresAt: expiry, isBlocked: false, blockReason: '' })
      setRestaurant({ ...restaurant, licenseExpiresAt: expiry, isBlocked: false, blockReason: undefined })
      toast.success(`Лицензия до ${new Date(expiry).toLocaleDateString('ru')}`)
      setLicenseDate('')
    } catch { toast.error('Ошибка') }
    finally { setRenewLoading(false) }
  }

  const handleRemoveExpiry = async () => {
    if (!restaurant) return
    setRenewLoading(true)
    try {
      await updateRestaurant(restaurant.id, { licenseExpiresAt: '' })
      setRestaurant({ ...restaurant, licenseExpiresAt: undefined })
      toast.success('Лицензия теперь бессрочная')
    } catch { toast.error('Ошибка') }
    finally { setRenewLoading(false) }
  }

  const handleRegenerateKey = async () => {
    if (!restaurant) return
    if (!confirm('Сгенерировать новый ключ? Старый перестанет работать.')) return
    try {
      const prefix = restaurant.slug.slice(0, 3).toUpperCase()
      const year = new Date().getFullYear()
      const random = Math.random().toString(36).slice(2, 8).toUpperCase()
      const newKey = `${prefix}-${year}-${random}`
      await updateRestaurant(restaurant.id, { licenseKey: newKey })
      setRestaurant({ ...restaurant, licenseKey: newKey })
      toast.success(`Новый ключ: ${newKey}`)
    } catch { toast.error('Ошибка') }
  }

  const handleDeleteUser = async (userId: string, userName: string) => {
    if (!window.confirm(`Удалить пользователя ${userName}?`)) return
    try {
      await deleteUser(userId)
      setUsers(prev => prev.filter(u => u.id !== userId))
      toast.success('Удалён')
    } catch { toast.error('Ошибка удаления') }
  }

  const openPasswordDialog = (u: User) => {
    setPasswordUser(u)
    setNewPassword('')
  }

  const handleSavePassword = async () => {
    if (!passwordUser) return
    const pwd = newPassword.trim()
    if (pwd.length < 4) {
      toast.error('Пароль должен быть не короче 4 символов')
      return
    }
    setSavingPassword(true)
    try {
      await updateUser(passwordUser.id, { password: pwd })
      toast.success(`Пароль для ${passwordUser.name} обновлён`)
      setPasswordUser(null)
      setNewPassword('')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка обновления пароля')
    } finally {
      setSavingPassword(false)
    }
  }

  const handleResetPassword = async (u: User) => {
    if (!window.confirm(`Сбросить пароль пользователя ${u.name} на «1234»?`)) return
    try {
      await updateUser(u.id, { password: '1234' })
      toast.success(`Пароль сброшен на 1234`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка сброса пароля')
    }
  }

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-64">
        <div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    )
  }

  if (!restaurant) {
    return <div className="p-6 text-center text-muted-foreground">Ресторан не найден</div>
  }

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      {/* Back */}
      <Link to="/admin/restaurants" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" />
        Назад к списку
      </Link>

      {/* Header */}
      <div className="flex items-center gap-4">
        <div className="size-14 rounded-xl bg-primary/10 flex items-center justify-center text-xl font-bold text-primary">
          {restaurant.name[0]}
        </div>
        <div>
          <h1 className="text-xl font-bold text-foreground">{restaurant.name}</h1>
          <p className="text-sm text-muted-foreground">{restaurant.slug} · Создан {new Date(restaurant.createdAt).toLocaleDateString('ru')}</p>
          {restaurant.licenseKey && (
            <div className="flex items-center gap-2 mt-1">
              <span className="text-xs text-muted-foreground">Лицензионный ключ:</span>
              <code className="text-xs font-mono bg-blue-50 text-blue-700 px-2 py-0.5 rounded border border-blue-200">{restaurant.licenseKey}</code>
              <button onClick={() => { navigator.clipboard.writeText(restaurant.licenseKey!); toast.success('Скопировано') }}
                className="text-[10px] text-primary hover:underline">Копировать</button>
            </div>
          )}
          {restaurant.localServerIp && (
            <p className="text-xs text-emerald-600 mt-0.5">Локальный сервер: {restaurant.localServerIp}</p>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-card rounded-xl border border-border p-4 flex items-center gap-3">
          <Users className="size-5 text-blue-500" />
          <div>
            <p className="text-xs text-muted-foreground">Сотрудники</p>
            <p className="text-lg font-bold">{stats.usersCount}</p>
          </div>
        </div>
        <div className="bg-card rounded-xl border border-border p-4 flex items-center gap-3">
          <ShoppingBag className="size-5 text-emerald-500" />
          <div>
            <p className="text-xs text-muted-foreground">Заказы</p>
            <p className="text-lg font-bold">{stats.ordersCount}</p>
          </div>
        </div>
        <div className="bg-card rounded-xl border border-border p-4 flex items-center gap-3">
          <TrendingUp className="size-5 text-amber-500" />
          <div>
            <p className="text-xs text-muted-foreground">Выручка</p>
            <p className="text-lg font-bold">{formatCurrency(stats.totalRevenue)}</p>
          </div>
        </div>
      </div>

      {/* License management */}
      <div className="bg-card rounded-xl border border-border p-5 space-y-4">
        <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Key className="size-4" /> Лицензия
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div>
            <p className="text-xs text-muted-foreground mb-1">Ключ</p>
            <div className="flex items-center gap-1.5">
              <code className="text-sm font-mono font-medium">{restaurant.licenseKey || '—'}</code>
              {restaurant.licenseKey && (
                <button onClick={() => { navigator.clipboard.writeText(restaurant.licenseKey!); toast.success('Скопировано') }}
                  className="text-muted-foreground hover:text-foreground"><svg className="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
              )}
            </div>
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-1">Статус</p>
            <p className={`text-sm font-medium ${getLicenseStatus().color}`}>
              <CalendarClock className="size-3.5 inline mr-1" />
              {getLicenseStatus().label}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-1">Истекает</p>
            <p className="text-sm font-medium">
              {restaurant.licenseExpiresAt ? new Date(restaurant.licenseExpiresAt).toLocaleDateString('ru') : 'Бессрочно'}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-1">Действия</p>
            <button onClick={handleRegenerateKey} className="text-xs text-primary hover:underline flex items-center gap-1">
              <RefreshCw className="size-3" /> Новый ключ
            </button>
          </div>
        </div>

        {/* Renew / extend / set license */}
        <div className="flex flex-wrap items-center gap-3 pt-3 border-t border-border">
          <span className="text-sm text-muted-foreground">Продлить на:</span>
          {[1, 3, 6, 12].map(m => (
            <button key={m} onClick={() => setLicenseMonths(m)}
              className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${licenseMonths === m ? 'bg-primary text-primary-foreground border-primary' : 'bg-background border-border hover:bg-muted'}`}>
              {m} мес
            </button>
          ))}
          <button onClick={handleRenewLicense} disabled={renewLoading}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
            <CalendarClock className="size-4" />
            {renewLoading ? '...' : 'Продлить'}
          </button>
        </div>
        <div className="flex items-center gap-3 pt-2">
          <span className="text-sm text-muted-foreground">Или назначить дату:</span>
          <input
            type="date"
            value={licenseDate}
            onChange={e => setLicenseDate(e.target.value)}
            min={new Date().toISOString().split('T')[0]}
            className="px-3 py-1.5 text-sm bg-background border border-border rounded-lg"
          />
          <button onClick={handleSetLicenseDate} disabled={!licenseDate || renewLoading}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
            Назначить
          </button>
          {restaurant.licenseExpiresAt && (
            <button onClick={handleRemoveExpiry} disabled={renewLoading}
              className="text-xs text-muted-foreground hover:text-destructive">
              Убрать срок (бессрочная)
            </button>
          )}
        </div>
      </div>

      {/* Desktop client control */}
      {(restaurant.licenseKey || restaurant.lastSeenAt) && (() => {
        const info = getOnlineInfo(restaurant.lastSeenAt)
        const StatusIcon = info.icon
        return (
          <div className="bg-card rounded-xl border border-border p-5 space-y-4">
            <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Monitor className="size-4" /> Desktop клиент
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div>
                <p className="text-xs text-muted-foreground mb-1">Статус</p>
                <div className={`flex items-center gap-1.5 text-sm font-medium ${info.color}`}>
                  <StatusIcon className="size-4" />
                  {info.label}
                </div>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Версия</p>
                <p className="text-sm font-medium">{restaurant.appVersion || '—'}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">IP адрес</p>
                <p className="text-sm font-medium">{restaurant.localServerIp || '—'}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Лицензия</p>
                <p className="text-sm font-medium">
                  {restaurant.isBlocked
                    ? <span className="text-red-600 flex items-center gap-1"><ShieldOff className="size-3.5" /> Заблокирован</span>
                    : <span className="text-emerald-600 flex items-center gap-1"><ShieldCheck className="size-3.5" /> Активна</span>
                  }
                </p>
              </div>
            </div>

            {restaurant.isBlocked ? (
              <div className="flex items-center gap-3 pt-2 border-t border-border">
                {restaurant.blockReason && (
                  <p className="text-xs text-red-600 flex-1">Причина: {restaurant.blockReason}</p>
                )}
                <button
                  onClick={handleUnblock}
                  disabled={blocking}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  <ShieldCheck className="size-4" />
                  {blocking ? 'Разблокировка...' : 'Разблокировать'}
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-3 pt-2 border-t border-border">
                <input
                  value={blockReason}
                  onChange={e => setBlockReason(e.target.value)}
                  placeholder="Причина блокировки (необязательно)"
                  className="flex-1 px-3 py-2 bg-background border border-border rounded-lg text-sm"
                />
                <button
                  onClick={handleBlock}
                  disabled={blocking}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                >
                  <ShieldOff className="size-4" />
                  {blocking ? 'Блокировка...' : 'Заблокировать'}
                </button>
              </div>
            )}
          </div>
        )
      })()}

      {/* Seed data */}
      <SeedDataSection restaurantId={restaurant.id} restaurantName={restaurant.name} />

      {/* Edit form */}
      <div className="bg-card rounded-xl border border-border p-5 space-y-4">
        <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Building2 className="size-4" /> Настройки ресторана
        </h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs font-medium block mb-1">Название</label>
            <input value={editName} onChange={e => setEditName(e.target.value)} className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm" />
          </div>
          <div>
            <label className="text-xs font-medium block mb-1">Адрес</label>
            <input value={editAddress} onChange={e => setEditAddress(e.target.value)} className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm" />
          </div>
          <div>
            <label className="text-xs font-medium block mb-1">Телефон</label>
            <input value={editPhone} onChange={e => setEditPhone(e.target.value.replace(/[^\d+\-\s()]/g, ''))} inputMode="tel" placeholder="+992 ..." className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm" />
          </div>
          <div>
            <label className="text-xs font-medium block mb-1">Обслуживание %</label>
            <input type="number" min={0} max={30} value={editService} onChange={e => setEditService(Number(e.target.value))} className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm" />
          </div>
        </div>
        <button onClick={handleSave} disabled={saving} className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
          <Save className="size-4" />
          {saving ? 'Сохранение...' : 'Сохранить'}
        </button>
      </div>

      {/* Users */}
      <div className="bg-card rounded-xl border border-border">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground">Сотрудники ({users.length})</h2>
          <button onClick={() => setAddUserOpen(true)} className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline">
            <Plus className="size-3.5" />
            Добавить
          </button>
        </div>
        <div className="divide-y divide-border">
          {users.map(u => (
            <div key={u.id} className="flex items-center justify-between px-5 py-3">
              <div className="flex items-center gap-3">
                <div className="size-8 rounded-full bg-muted flex items-center justify-center text-xs font-bold text-muted-foreground">
                  {u.name.split(' ').map(n => n[0]).join('')}
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground">{u.name}</p>
                  <p className="text-xs text-muted-foreground">@{u.username} · {ROLE_LABELS[u.role] || u.role}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {u.salary ? <span className="text-xs text-muted-foreground mr-1">{formatCurrency(u.salary)}/мес</span> : null}
                <button
                  onClick={() => openPasswordDialog(u)}
                  className="p-1.5 rounded-lg text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
                  title="Сменить пароль"
                >
                  <Key className="size-4" />
                </button>
                <button
                  onClick={() => handleResetPassword(u)}
                  className="p-1.5 rounded-lg text-muted-foreground hover:text-amber-600 hover:bg-amber-50 transition-colors"
                  title="Сбросить пароль на 1234"
                >
                  <RefreshCw className="size-4" />
                </button>
                <button
                  onClick={() => handleDeleteUser(u.id, u.name)}
                  className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                  title="Удалить"
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            </div>
          ))}
          {users.length === 0 && (
            <div className="px-5 py-6 text-center text-muted-foreground text-sm">Нет сотрудников</div>
          )}
        </div>
      </div>

      {/* Danger zone — clear operations (destructive but recoverable concept) */}
      <div className="bg-amber-50 rounded-xl border-2 border-amber-200 p-5 space-y-3">
        <h2 className="text-sm font-semibold text-amber-800">Сброс операций</h2>
        <p className="text-xs text-amber-700">
          Удалит все заказы, смены, финансовые операции, движения склада, бронирования, журнал действий, инвентаризации, накладные, списания, заготовки. Сбросит балансы счетов, статистику клиентов и поставщиков, статус столов в «Свободен».
          <br /><strong>Сохранится:</strong> меню, ингредиенты (включая остатки), тех.карты, столы, зоны, сотрудники, поставщики, клиенты (без статистики), счета, активы/пассивы.
        </p>
        <button
          onClick={() => { setClearOpsConfirm(''); setClearOpsOpen(true) }}
          className="inline-flex items-center gap-2 rounded-lg bg-amber-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-amber-700"
        >
          <RefreshCw className="size-4" />
          Сбросить операции
        </button>
      </div>

      {/* Clear-operations confirmation dialog */}
      <Dialog open={clearOpsOpen} onOpenChange={setClearOpsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-amber-700">Сброс операций ресторана</DialogTitle>
            <DialogDescription>
              Все операционные данные будут удалены. Меню, склад, сотрудники, столы и зоны останутся. Действие необратимо — после подтверждения данные будут также удалены из облака.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-foreground">
              Для подтверждения введите название ресторана: <strong>{restaurant.name}</strong>
            </p>
            <input
              value={clearOpsConfirm}
              onChange={e => setClearOpsConfirm(e.target.value)}
              placeholder={restaurant.name}
              className="w-full px-3 py-2.5 text-sm bg-background border border-amber-300 rounded-lg focus:border-amber-500 focus:ring-1 focus:ring-amber-500 outline-none"
            />
          </div>
          <DialogFooter>
            <button onClick={() => setClearOpsOpen(false)} className="px-4 py-2 text-sm font-medium bg-card border border-border rounded-lg hover:bg-muted">
              Отмена
            </button>
            <button
              disabled={clearOpsConfirm !== restaurant.name || clearingOps}
              onClick={async () => {
                setClearingOps(true)
                try {
                  const result = await clearRestaurantOperations(restaurant.id)
                  const total = Object.values(result.counts).reduce((s, n) => s + n, 0)
                  toast.success(`Операции сброшены (${total} записей удалено)`)
                  setClearOpsOpen(false)
                  // Refresh stats
                  const s = await getRestaurantStats(restaurant.id)
                  setStats(s)
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : 'Ошибка сброса операций')
                } finally {
                  setClearingOps(false)
                }
              }}
              className="px-4 py-2 text-sm font-medium text-white bg-amber-600 rounded-lg hover:bg-amber-700 disabled:opacity-50 flex items-center gap-2"
            >
              <RefreshCw className={`size-4 ${clearingOps ? 'animate-spin' : ''}`} />
              {clearingOps ? 'Сброс...' : 'Сбросить операции'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Danger zone */}
      <div className="bg-red-50 rounded-xl border-2 border-red-200 p-5 space-y-3">
        <h2 className="text-sm font-semibold text-red-700">Удаление ресторана</h2>
        <p className="text-xs text-red-600">Удалит ресторан, всех сотрудников, все заказы, меню, склад и финансовые данные. Действие необратимо.</p>
        <button
          onClick={() => { setDeleteConfirmName(''); setDeleteOpen(true) }}
          className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-red-700"
        >
          <Trash2 className="size-4" />
          Удалить ресторан
        </button>
      </div>

      {/* Delete restaurant confirmation dialog */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-red-600">Удаление ресторана</DialogTitle>
            <DialogDescription>
              ВСЕ данные будут потеряны навсегда: сотрудники, заказы, меню, техкарты, склад, накладные, финансовые операции. Это действие НЕВОЗМОЖНО отменить.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-foreground">
              Для подтверждения введите название ресторана: <strong>{restaurant.name}</strong>
            </p>
            <input
              value={deleteConfirmName}
              onChange={e => setDeleteConfirmName(e.target.value)}
              placeholder={restaurant.name}
              className="w-full px-3 py-2.5 text-sm bg-background border border-red-300 rounded-lg focus:border-red-500 focus:ring-1 focus:ring-red-500 outline-none"
            />
          </div>
          <DialogFooter>
            <button onClick={() => setDeleteOpen(false)} className="px-4 py-2 text-sm font-medium bg-card border border-border rounded-lg hover:bg-muted">
              Отмена
            </button>
            <button
              disabled={deleteConfirmName !== restaurant.name || deleting}
              onClick={async () => {
                setDeleting(true)
                try {
                  await deleteRestaurant(restaurant.id)
                  toast.success(`Ресторан «${restaurant.name}» удалён`)
                  setDeleteOpen(false)
                  navigate('/admin/restaurants')
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : 'Ошибка удаления')
                } finally {
                  setDeleting(false)
                }
              }}
              className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50 flex items-center gap-2"
            >
              <Trash2 className="size-4" />
              {deleting ? 'Удаление...' : 'Удалить навсегда'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Change password dialog */}
      <Dialog open={!!passwordUser} onOpenChange={(v) => { if (!v) setPasswordUser(null) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Сменить пароль</DialogTitle>
            <DialogDescription>
              {passwordUser ? `Для пользователя ${passwordUser.name} (@${passwordUser.username})` : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <label className="text-xs font-medium block mb-1">Новый пароль *</label>
              <input
                type="text"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                placeholder="Минимум 4 символа"
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm"
                autoFocus
              />
              <p className="text-xs text-muted-foreground mt-1.5">Пользователь сможет войти с этим паролем немедленно.</p>
            </div>
          </div>
          <DialogFooter>
            <button
              onClick={() => setPasswordUser(null)}
              className="rounded-xl border border-border bg-card px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted"
            >
              Отмена
            </button>
            <button
              onClick={handleSavePassword}
              disabled={savingPassword || !newPassword.trim()}
              className="rounded-xl bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {savingPassword ? 'Сохранение...' : 'Сохранить'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add user dialog */}
      <Dialog open={addUserOpen} onOpenChange={setAddUserOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Добавить сотрудника</DialogTitle>
            <DialogDescription>В ресторан {restaurant.name}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <label className="text-xs font-medium block mb-1">ФИО *</label>
              <input value={newUserName} onChange={e => setNewUserName(e.target.value)} className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm" />
            </div>
            <div>
              <label className="text-xs font-medium block mb-1">Логин *</label>
              <input value={newUserUsername} onChange={e => setNewUserUsername(e.target.value)} className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm" />
            </div>
            <div>
              <label className="text-xs font-medium block mb-1">Роль</label>
              <select value={newUserRole} onChange={e => setNewUserRole(e.target.value as UserRole)} className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm">
                {AVAILABLE_ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium block mb-1">Зарплата (TJS)</label>
              <input type="number" value={newUserSalary} onChange={e => setNewUserSalary(Number(e.target.value))} className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm" />
            </div>
            <p className="text-xs text-muted-foreground">Пароль по умолчанию: 1234</p>
          </div>
          <DialogFooter>
            <button onClick={handleAddUser} disabled={!newUserName || !newUserUsername} className="w-full rounded-xl bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
              Добавить
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ─── Seed Data Section ──────────────────────────────────────────────────────

function SeedDataSection({ restaurantId, restaurantName }: { restaurantId: string; restaurantName: string }) {
  const [seeding, setSeeding] = useState(false)
  const [seeded, setSeeded] = useState(false)

  const handleSeed = async () => {
    if (!confirm(`Создать начальные данные для «${restaurantName}»?\n\n• 4 зоны (Зал, Терраса, Бар, VIP)\n• 14 столов\n• 3 финансовых счёта\n• 18 ингредиентов\n• 10 блюд с техкартами\n\nЭто демо-набор — ресторан может изменить через импорт или вручную.`)) return
    setSeeding(true)
    try {
      const result = await seedRestaurantData(restaurantId)
      toast.success(`Создано: ${result.zones} зон, ${result.tables} столов, ${result.accounts} счетов, ${result.ingredients} ингредиентов, ${result.menuItems} блюд, ${result.techCardLines} техкарт`)
      setSeeded(true)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка создания данных')
    } finally {
      setSeeding(false)
    }
  }

  return (
    <div className="bg-card rounded-xl border border-border p-5 space-y-3">
      <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
        <Database className="size-4" /> Начальные данные
      </h2>
      <p className="text-xs text-muted-foreground">
        Создать стандартный демо-набор: зоны, столы, счета, ингредиенты, меню с техкартами и себестоимостью. Ресторан может заменить через импорт Excel или вручную.
      </p>
      <button
        onClick={handleSeed}
        disabled={seeding || seeded}
        className={`inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors ${
          seeded
            ? 'bg-emerald-100 text-emerald-700 cursor-default'
            : 'bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50'
        }`}
      >
        <Database className="size-4" />
        {seeding ? 'Создание...' : seeded ? '✓ Данные созданы' : 'Создать начальные данные'}
      </button>
    </div>
  )
}
