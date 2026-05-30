'use client'

import { useState, useEffect, memo, useCallback } from 'react'
import { useAuth } from '@/lib/auth-store'
import { formatCurrency } from '@/lib/helpers'
import {
  type User, type UserPermissions, type PermissionKey, type UserRole as UserRoleType,
  ROLE_LABELS, PERMISSION_GROUPS, PERMISSION_LABELS, ALL_PERMISSIONS,
  ROLE_DEFAULT_PERMISSIONS, buildNavFromPermissions,
} from '@/lib/types'
import {
  type User as UserType2, type UserPermissions as UP2,
  ALL_STATIONS, STATION_LABELS, STATION_ICONS, type MenuStation,
} from '@/lib/types'
import { fetchUsersByRestaurant, updateUserPermissions, createUserForRestaurant, deleteUser, updateUser, generateUniquePin } from '@/lib/queries'
import { Shield, Save, RotateCcw, Check, Minus, Plus, Trash2, Users, Search, Pencil, Grid3X3, List, X, KeyRound } from 'lucide-react'
import { toast } from 'sonner'

type PermMap = Record<string, Record<string, boolean>>
type Tab = 'staff' | 'matrix'

export default function UserPermissionsPage() {
  const { user, canDo } = useAuth()
  const [employees, setEmployees] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [permMatrix, setPermMatrix] = useState<PermMap>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [dirty, setDirty] = useState<Set<string>>(new Set())
  const [tab, setTab] = useState<Tab>('staff')
  const [search, setSearch] = useState('')

  // Add user form: показ inline, но state — внутри AddUserForm (мемо-компонент).
  // Раньше state жил здесь → каждое нажатие клавиши в input ре-рендерило ВЕСЬ
  // page.tsx (включая список 20-50 сотрудников × матрицу прав) → UI «фризился».
  const [showAddUser, setShowAddUser] = useState(false)
  const [addingUser, setAddingUser] = useState(false)

  // Edit user
  const [editingEmp, setEditingEmp] = useState<User | null>(null)
  const [editForm, setEditForm] = useState({ name: '', username: '', role: 'waiter' as UserRoleType, salary: 0, password: '', position: '', birthDate: '', station: '', shiftNumber: 0, pin: '' })
  const [savingEdit, setSavingEdit] = useState(false)

  // Edit permissions inline (staff tab)
  const [editingUserId, setEditingUserId] = useState<string | null>(null)

  const STAFF_ROLES: UserRoleType[] = ['manager', 'waiter', 'cashier', 'cook', 'storekeeper', 'accountant', 'other']

  const loadEmployees = async () => {
    if (!user?.restaurantId) return
    const data = await fetchUsersByRestaurant(user.restaurantId)
    // Show all users including owner (for PIN management), exclude only superadmin
    const emps = data.filter(u => u.role !== 'superadmin')
    setEmployees(emps)
    const matrix: PermMap = {}
    for (const emp of emps) {
      const saved = emp.permissions?.actions && Object.keys(emp.permissions.actions).length > 0 ? emp.permissions.actions : null
      const defaults = ROLE_DEFAULT_PERMISSIONS[emp.role].actions
      const full: Record<string, boolean> = {}
      for (const key of ALL_PERMISSIONS) {
        full[key] = saved ? (saved[key] === true) : (defaults[key] === true)
      }
      matrix[emp.id] = full
    }
    setPermMatrix(matrix)
  }

  useEffect(() => {
    loadEmployees().then(() => setLoading(false)).catch(() => setLoading(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Staff filters
  const [roleFilter, setRoleFilter] = useState<string>('all')
  const [shiftFilter, setShiftFilter] = useState<string>('all')

  // Filtered employees for staff list
  const filtered = employees.filter(e => {
    if (roleFilter !== 'all' && e.role !== roleFilter) return false
    if (shiftFilter !== 'all') {
      if (shiftFilter === 'none' && e.shiftNumber) return false
      if (shiftFilter !== 'none' && e.shiftNumber !== Number(shiftFilter)) return false
    }
    if (search.trim()) {
      const q = search.toLowerCase()
      return e.name.toLowerCase().includes(q) || e.username.toLowerCase().includes(q) || (e.position || '').toLowerCase().includes(q)
    }
    return true
  })

  // Unique roles and shifts for filter tabs
  const roleStats = employees.reduce<Record<string, number>>((acc, e) => { acc[e.role] = (acc[e.role] || 0) + 1; return acc }, {})
  const shiftStats = employees.reduce<Record<string, number>>((acc, e) => { const k = e.shiftNumber ? String(e.shiftNumber) : 'none'; acc[k] = (acc[k] || 0) + 1; return acc }, {})

  // ─── Permission matrix actions ──────────────────────────────────────────
  const togglePerm = (userId: string, key: PermissionKey) => {
    setPermMatrix(prev => ({ ...prev, [userId]: { ...prev[userId], [key]: !prev[userId]?.[key] } }))
    setDirty(prev => new Set(prev).add(userId))
  }

  const resetUser = (emp: User) => {
    const defaults = ROLE_DEFAULT_PERMISSIONS[emp.role].actions
    const full: Record<string, boolean> = {}
    for (const key of ALL_PERMISSIONS) { full[key] = defaults[key] === true }
    setPermMatrix(prev => ({ ...prev, [emp.id]: full }))
    setDirty(prev => new Set(prev).add(emp.id))
  }

  const saveUser = async (emp: User) => {
    const actions = { ...permMatrix[emp.id] }
    if (!actions || Object.keys(actions).length === 0) return
    setSaving(emp.id)
    try {
      const fullActions: Record<string, boolean> = {}
      for (const key of ALL_PERMISSIONS) { fullActions[key] = actions[key] === true }
      const perms: UserPermissions = { nav: buildNavFromPermissions({ nav: [], actions: fullActions }), actions: fullActions }
      await updateUserPermissions(emp.id, perms)
      setPermMatrix(prev => ({ ...prev, [emp.id]: { ...fullActions } }))
      setEmployees(prev => prev.map(e => e.id === emp.id ? { ...e, permissions: perms } : e))
      setDirty(prev => { const n = new Set(prev); n.delete(emp.id); return n })
      toast.success(`Права ${emp.name} сохранены`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка сохранения')
    } finally { setSaving(null) }
  }

  const saveAll = async () => {
    for (const emp of employees.filter(e => dirty.has(e.id))) { await saveUser(emp) }
  }

  // ─── Staff CRUD ─────────────────────────────────────────────────────────
  // Принимает form values из AddUserForm (локальный state там, не здесь).
  // Стабильная ссылка через useCallback — чтобы memo-обёртка реально работала.
  const handleAddUser = useCallback(async (form: AddUserFormValues) => {
    if (!form.name.trim() || !form.username.trim() || !user?.restaurantId) return
    setAddingUser(true)
    try {
      await createUserForRestaurant({
        name: form.name.trim(),
        username: form.username.trim().toLowerCase(),
        role: form.role,
        restaurantId: user.restaurantId,
        salary: form.salary,
        password: form.password || '1234',
      })
      toast.success(`${form.name.trim()} добавлен`)
      setShowAddUser(false)
      await loadEmployees()
    } catch (e) {
      console.error('[createUser]', e)
      toast.error(e instanceof Error ? e.message : 'Ошибка')
    } finally {
      setAddingUser(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.restaurantId])

  const handleCancelAdd = useCallback(() => setShowAddUser(false), [])

  const handleDeleteUser = async (emp: User) => {
    if (!confirm(`Удалить "${emp.name}"?`)) return
    try {
      await deleteUser(emp.id)
      toast.success('Удалён')
      await loadEmployees()
    } catch (e) {
      // Полная диагностика в консоли + понятное сообщение пользователю.
      // Без этого юзер видит только «Ошибка», а в DevTools — ничего.
      console.error('[deleteUser]', emp.id, emp.name, e)
      const msg = e instanceof Error ? e.message : 'Ошибка удаления'
      toast.error(`Не удалось удалить: ${msg}`)
    }
  }

  const openEditUser = (emp: User) => {
    setEditingEmp(emp)
    setEditForm({
      name: emp.name,
      username: emp.username,
      role: emp.role,
      salary: emp.salary || 0,
      password: '',
      position: emp.position || '',
      birthDate: emp.birthDate || '',
      station: emp.station || '',
      shiftNumber: emp.shiftNumber || 0,
      pin: emp.pin != null ? String(emp.pin) : '',
    })
  }

  const handleSaveEdit = async () => {
    if (!editingEmp) return
    setSavingEdit(true)
    try {
      const updates: Record<string, unknown> = {
        name: editForm.name.trim(),
        username: editForm.username.trim().toLowerCase(),
        role: editForm.role,
        salary: editForm.salary,
        position: editForm.position.trim() || null,
        birth_date: editForm.birthDate || null,
        station: editForm.station || null,
        shift_number: editForm.shiftNumber || null,
      }
      if (editForm.password.trim()) updates.password = editForm.password.trim()
      if (editForm.pin.trim()) updates.pin = editForm.pin.trim()
      await updateUser(editingEmp.id, updates)
      toast.success(`${editForm.name} обновлён`)
      setEditingEmp(null)
      await loadEmployees()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка')
    } finally { setSavingEdit(false) }
  }

  // ─── Guards ─────────────────────────────────────────────────────────────
  if (!canDo('users.manage')) {
    return <div className="p-6 flex items-center justify-center h-64"><p className="text-muted-foreground">Нет доступа</p></div>
  }
  if (loading) {
    return <div className="p-6 flex items-center justify-center h-64"><div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>
  }

  const activePermsCount = (emp: User) => {
    const m = permMatrix[emp.id]
    return m ? Object.values(m).filter(Boolean).length : 0
  }

  return (
    <div className="p-4 md:p-6 space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">Персонал и доступы</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            {employees.length} сотрудник{employees.length === 1 ? '' : employees.length < 5 ? 'а' : 'ов'}
            {dirty.size > 0 && <span className="text-amber-600 ml-2">· {dirty.size} не сохранено</span>}
          </p>
        </div>
        <div className="flex gap-2">
          {dirty.size > 0 && (
            <button onClick={saveAll} className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2.5 rounded-xl text-sm font-medium hover:bg-primary/90 transition-colors">
              <Save className="size-4" />Сохранить все
            </button>
          )}
          <button onClick={() => setShowAddUser(!showAddUser)} className="flex items-center gap-2 bg-emerald-600 text-white px-4 py-2.5 rounded-xl text-sm font-medium hover:bg-emerald-700 transition-colors">
            <Plus className="size-4" />Сотрудник
          </button>
        </div>
      </div>

      {/* Add employee form — мемо-компонент с локальным state, чтобы ввод
          в input не ре-рендерил весь список сотрудников. */}
      {showAddUser && (
        <AddUserForm
          submitting={addingUser}
          onSubmit={handleAddUser}
          onCancel={handleCancelAdd}
        />
      )}

      {/* Tabs */}
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <div className="flex gap-1 bg-muted/50 p-1 rounded-xl">
            <button onClick={() => setTab('staff')} className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium transition-colors ${tab === 'staff' ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground'}`}>
              <List className="size-3.5" />Сотрудники
              <span className="bg-muted px-1.5 py-0.5 rounded text-[10px] font-bold">{employees.length}</span>
            </button>
            <button onClick={() => setTab('matrix')} className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium transition-colors ${tab === 'matrix' ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground'}`}>
              <Grid3X3 className="size-3.5" />Матрица доступов
            </button>
          </div>
          {tab === 'staff' && (
            <div className="relative flex-1 max-w-xs">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Поиск..." className="w-full pl-9 pr-3 py-2 bg-card border border-border rounded-xl text-sm" />
            </div>
          )}
        </div>

        {/* Role + Shift filters */}
        {tab === 'staff' && employees.length > 5 && (
          <div className="flex flex-wrap gap-2">
            {/* Role filter */}
            <div className="flex gap-1 bg-muted/30 p-0.5 rounded-lg">
              <button onClick={() => setRoleFilter('all')}
                className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors ${roleFilter === 'all' ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground'}`}>
                Все
              </button>
              {Object.entries(roleStats).sort((a, b) => b[1] - a[1]).map(([role, count]) => (
                <button key={role} onClick={() => setRoleFilter(roleFilter === role ? 'all' : role)}
                  className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors ${roleFilter === role ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground'}`}>
                  {ROLE_LABELS[role as UserRoleType] || role}
                  <span className="ml-1 opacity-50">{count}</span>
                </button>
              ))}
            </div>

            {/* Shift filter */}
            {Object.keys(shiftStats).length > 1 && (
              <div className="flex gap-1 bg-muted/30 p-0.5 rounded-lg">
                <button onClick={() => setShiftFilter('all')}
                  className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors ${shiftFilter === 'all' ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground'}`}>
                  Все смены
                </button>
                {Object.entries(shiftStats).sort((a, b) => a[0].localeCompare(b[0])).map(([shift, count]) => (
                  <button key={shift} onClick={() => setShiftFilter(shiftFilter === shift ? 'all' : shift)}
                    className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors ${shiftFilter === shift ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground'}`}>
                    {shift === 'none' ? 'Без смены' : `${shift} смена`}
                    <span className="ml-1 opacity-50">{count}</span>
                  </button>
                ))}
              </div>
            )}

            {/* Active filters indicator */}
            {(roleFilter !== 'all' || shiftFilter !== 'all' || search) && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>{filtered.length} из {employees.length}</span>
                <button onClick={() => { setRoleFilter('all'); setShiftFilter('all'); setSearch('') }} className="text-primary hover:underline">Сбросить</button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Empty state */}
      {employees.length === 0 && !showAddUser && (
        <div className="bg-card rounded-xl border border-border p-12 text-center">
          <Users className="size-10 text-muted-foreground/30 mx-auto mb-3" />
          <p className="font-medium text-foreground">Нет сотрудников</p>
        </div>
      )}

      {/* ═══ TAB: Staff list ═══ */}
      {tab === 'staff' && employees.length > 0 && (
        <div className="space-y-2">
          {filtered.map(emp => {
            const permsCount = activePermsCount(emp)
            const isEditing = editingUserId === emp.id
            // «Настроено» = текущее состояние тогглов в permMatrix отличается
            // от дефолтов роли. Читаем из permMatrix (а не из emp.permissions),
            // чтобы badge появлялся СРАЗУ при изменении галочки и сохранялся
            // после save/refresh — без видимого «провала» между сохранением
            // и тем когда Dexie/UI допрочитают свежие данные.
            const matrix = permMatrix[emp.id]
            const isCustomized = !!matrix && ALL_PERMISSIONS.some(
              p => (matrix[p] ?? false) !== (ROLE_DEFAULT_PERMISSIONS[emp.role].actions[p] ?? false)
            )

            return (
              <div key={emp.id} className="bg-card rounded-xl border border-border overflow-hidden">
                {/* Main row */}
                <div className="flex items-center gap-4 p-4">
                  <div className="size-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0 text-sm font-bold text-primary">
                    {emp.name.charAt(0)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-foreground text-sm">{emp.name}</span>
                      <span className="text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded">{ROLE_LABELS[emp.role]}</span>
                      {emp.position && <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded">{emp.position}</span>}
                      {emp.station && <span className="text-xs">{STATION_ICONS[emp.station as MenuStation] || ''}</span>}
                      {emp.shiftNumber && <span className="text-[10px] bg-muted text-muted-foreground px-1.5 py-0.5 rounded">{emp.shiftNumber} смена</span>}
                      {isCustomized && <span className="text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded font-medium">Настроено</span>}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
                      <span>@{emp.username}</span>
                      {emp.birthDate && <span>{new Date(emp.birthDate).toLocaleDateString('ru', { day: 'numeric', month: 'short', year: 'numeric' })}</span>}
                      {emp.salary ? <span>{formatCurrency(emp.salary)}</span> : null}
                      {emp.pin && <span className="font-mono bg-primary/10 text-primary px-1.5 py-0.5 rounded">PIN: {emp.pin}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => openEditUser(emp)} title="Редактировать"
                      className="p-2 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors">
                      <Pencil className="size-4" />
                    </button>
                    <button onClick={() => setEditingUserId(isEditing ? null : emp.id)} title="Настроить права"
                      className={`p-2 rounded-lg transition-colors ${isEditing ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}>
                      <Shield className="size-4" />
                    </button>
                    {emp.role !== 'owner' && (
                      <button onClick={() => handleDeleteUser(emp)} title="Удалить" className="p-2 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors">
                        <Trash2 className="size-4" />
                      </button>
                    )}
                  </div>
                </div>

                {/* Inline permissions editor */}
                {isEditing && (
                  <div className="border-t border-border p-4 bg-muted/20 space-y-3">
                    {PERMISSION_GROUPS.map(group => (
                      <div key={group.label}>
                        <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2">{group.label}</p>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                          {group.keys.map(key => {
                            const isOn = permMatrix[emp.id]?.[key] ?? false
                            const defaultVal = ROLE_DEFAULT_PERMISSIONS[emp.role].actions[key] ?? false
                            const isChanged = isOn !== defaultVal
                            return (
                              <button key={key} onClick={() => togglePerm(emp.id, key)}
                                className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors ${isOn ? 'bg-emerald-50 dark:bg-emerald-950/20' : 'hover:bg-muted/50'}`}>
                                <span className={`size-5 rounded flex items-center justify-center shrink-0 ${
                                  isOn ? isChanged ? 'bg-amber-500 text-white' : 'bg-emerald-500 text-white' : 'bg-muted border border-border'
                                }`}>
                                  {isOn && <Check className="size-3" />}
                                </span>
                                <span className={`text-xs ${isOn ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
                                  {PERMISSION_LABELS[key]}
                                </span>
                                {isChanged && <span className="text-[9px] text-amber-600 ml-auto">изменено</span>}
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    ))}
                    <div className="flex gap-2 pt-2">
                      <button onClick={() => resetUser(emp)} className="flex items-center gap-1.5 px-3 py-2 border border-border rounded-lg text-xs font-medium text-foreground hover:bg-muted">
                        <RotateCcw className="size-3" />Сбросить
                      </button>
                      {dirty.has(emp.id) && (
                        <button onClick={() => saveUser(emp)} disabled={saving === emp.id}
                          className="flex items-center gap-1.5 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-xs font-medium hover:bg-primary/90 disabled:opacity-50">
                          <Save className="size-3" />{saving === emp.id ? 'Сохранение...' : 'Сохранить'}
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
          {filtered.length === 0 && search && (
            <div className="text-center py-8 text-sm text-muted-foreground">Ничего не найдено</div>
          )}
        </div>
      )}

      {/* ═══ TAB: Role-based Matrix ═══ */}
      {tab === 'matrix' && (() => {
        const MATRIX_ROLES: UserRoleType[] = ['manager', 'waiter', 'cashier', 'cook', 'storekeeper', 'accountant', 'other']

        // Toggle a permission for ALL employees of a given role
        const toggleRolePerm = (role: UserRoleType, key: PermissionKey) => {
          const roleEmps = employees.filter(e => e.role === role)
          if (roleEmps.length === 0) return
          // Check current state: if ALL are on → turn off, otherwise turn on
          const allOn = roleEmps.every(e => permMatrix[e.id]?.[key] === true)
          const newVal = !allOn
          setPermMatrix(prev => {
            const next = { ...prev }
            for (const emp of roleEmps) {
              next[emp.id] = { ...next[emp.id], [key]: newVal }
            }
            return next
          })
          setDirty(prev => {
            const n = new Set(prev)
            roleEmps.forEach(e => n.add(e.id))
            return n
          })
        }

        // Save all employees of a role
        const saveRole = async (role: UserRoleType) => {
          const roleEmps = employees.filter(e => e.role === role && dirty.has(e.id))
          for (const emp of roleEmps) { await saveUser(emp) }
        }

        // Get current state for role+perm (from actual employee permissions, not defaults)
        const getRolePermState = (role: UserRoleType, key: PermissionKey): 'all' | 'some' | 'none' => {
          const roleEmps = employees.filter(e => e.role === role)
          if (roleEmps.length === 0) return ROLE_DEFAULT_PERMISSIONS[role].actions[key] ? 'all' : 'none'
          const onCount = roleEmps.filter(e => permMatrix[e.id]?.[key] === true).length
          if (onCount === roleEmps.length) return 'all'
          if (onCount > 0) return 'some'
          return 'none'
        }

        const roleDirtyCount = (role: UserRoleType) => employees.filter(e => e.role === role && dirty.has(e.id)).length

        return (
          <>
          <p className="text-xs text-muted-foreground">Нажмите на ячейку чтобы включить/выключить право для всех сотрудников роли.</p>
          <div className="bg-card rounded-xl border border-border overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm" style={{ minWidth: '700px' }}>
                <thead>
                  <tr className="border-b border-border bg-muted/40">
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide sticky left-0 bg-muted/40 z-10 min-w-[200px]">Разрешение</th>
                    {MATRIX_ROLES.map(role => {
                      const count = employees.filter(e => e.role === role).length
                      const dirtyCount = roleDirtyCount(role)
                      return (
                        <th key={role} className="px-2 py-3 text-center min-w-[90px]">
                          <div className="text-xs font-semibold text-foreground">{ROLE_LABELS[role]}</div>
                          <div className="text-[10px] text-muted-foreground font-normal">{count} чел.</div>
                          {dirtyCount > 0 && (
                            <button onClick={() => saveRole(role)} className="text-[10px] text-primary hover:underline mt-0.5 flex items-center justify-center gap-0.5 mx-auto">
                              <Save className="size-2.5" />Сохранить
                            </button>
                          )}
                        </th>
                      )
                    })}
                  </tr>
                </thead>
                {PERMISSION_GROUPS.map(group => (
                  <tbody key={group.label}>
                    <tr className="bg-muted/20">
                      <td colSpan={MATRIX_ROLES.length + 1} className="px-4 py-2 text-xs font-bold text-muted-foreground uppercase tracking-wider sticky left-0 bg-muted/20">{group.label}</td>
                    </tr>
                    {group.keys.map(key => (
                      <tr key={key} className="border-t border-border/50 hover:bg-muted/10 transition-colors">
                        <td className="px-4 py-2.5 text-sm text-foreground sticky left-0 bg-card z-10">{PERMISSION_LABELS[key]}</td>
                        {MATRIX_ROLES.map(role => {
                          const state = getRolePermState(role, key)
                          const defaultVal = ROLE_DEFAULT_PERMISSIONS[role].actions[key] === true
                          const isChanged = (state === 'all') !== defaultVal
                          return (
                            <td key={role} className="px-2 py-2.5 text-center">
                              <button
                                onClick={() => toggleRolePerm(role, key)}
                                className={`inline-flex items-center justify-center size-7 rounded-lg border-2 transition-all ${
                                  state === 'all'
                                    ? isChanged ? 'bg-amber-500 border-amber-500 text-white' : 'bg-emerald-500 border-emerald-500 text-white'
                                  : state === 'some'
                                    ? 'bg-amber-200 border-amber-300 text-amber-700'
                                  : isChanged ? 'bg-red-50 border-red-300 text-red-400' : 'bg-muted/50 border-border text-muted-foreground/30'
                                }`}
                                title={state === 'all' ? 'Включено для всех' : state === 'some' ? 'Включено у части' : 'Выключено'}
                              >
                                {state === 'all' ? <Check className="size-3.5" /> : state === 'some' ? <Minus className="size-3.5" /> : <Minus className="size-3.5" />}
                              </button>
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                ))}
              </table>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5"><span className="size-4 rounded bg-emerald-500 flex items-center justify-center"><Check className="size-2.5 text-white" /></span>Вкл (дефолт)</span>
            <span className="flex items-center gap-1.5"><span className="size-4 rounded bg-amber-500 flex items-center justify-center"><Check className="size-2.5 text-white" /></span>Вкл (изменено)</span>
            <span className="flex items-center gap-1.5"><span className="size-4 rounded bg-amber-200 border border-amber-300 flex items-center justify-center"><Minus className="size-2.5 text-amber-700" /></span>Частично</span>
            <span className="flex items-center gap-1.5"><span className="size-4 rounded bg-muted/50 border border-border flex items-center justify-center"><Minus className="size-2.5 text-muted-foreground/30" /></span>Выкл</span>
            <span className="ml-auto text-muted-foreground/60">Владелец имеет полный доступ</span>
          </div>
          </>
        )
      })()}

      {/* ═══ Edit Employee Dialog ═══ */}
      {editingEmp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setEditingEmp(null)}>
          <div className="bg-card rounded-2xl border border-border shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-5 border-b border-border">
              <h2 className="text-lg font-bold text-foreground">Редактировать сотрудника</h2>
              <button onClick={() => setEditingEmp(null)} className="p-1 text-muted-foreground hover:text-foreground"><X className="size-5" /></button>
            </div>
            <div className="p-5 space-y-4">
              {/* Row 1: Name, Username */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">ФИО</label>
                  <input value={editForm.name} onChange={e => setEditForm(p => ({ ...p, name: e.target.value }))}
                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm" />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Логин</label>
                  <input value={editForm.username} onChange={e => setEditForm(p => ({ ...p, username: e.target.value }))}
                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm" />
                </div>
              </div>

              {/* Row 2: Password, Role */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Новый пароль</label>
                  <input value={editForm.password} onChange={e => setEditForm(p => ({ ...p, password: e.target.value }))} placeholder="Оставить пустым — без изменений"
                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm" />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Роль</label>
                  <select value={editForm.role} onChange={e => setEditForm(p => ({ ...p, role: e.target.value as UserRoleType }))}
                    disabled={editingEmp?.role === 'owner'}
                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm disabled:opacity-50 disabled:cursor-not-allowed">
                    {editingEmp?.role === 'owner'
                      ? <option value="owner">Владелец</option>
                      : STAFF_ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)
                    }
                  </select>
                </div>
              </div>

              {/* Row 3: Position, Birth date */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Должность</label>
                  <input value={editForm.position} onChange={e => setEditForm(p => ({ ...p, position: e.target.value }))} placeholder="Салатчи (старший)"
                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm" />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Дата рождения</label>
                  <input type="date" value={editForm.birthDate} onChange={e => setEditForm(p => ({ ...p, birthDate: e.target.value }))}
                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm" />
                </div>
              </div>

              {/* Row 4: Station, Shift, Salary */}
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Станция</label>
                  <select value={editForm.station} onChange={e => setEditForm(p => ({ ...p, station: e.target.value }))}
                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm">
                    <option value="">— нет —</option>
                    {ALL_STATIONS.map(s => <option key={s} value={s}>{STATION_ICONS[s]} {STATION_LABELS[s]}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Смена</label>
                  <select value={editForm.shiftNumber} onChange={e => setEditForm(p => ({ ...p, shiftNumber: Number(e.target.value) }))}
                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm">
                    <option value={0}>— нет —</option>
                    <option value={1}>1 смена</option>
                    <option value={2}>2 смена</option>
                    <option value={3}>3 смена</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Зарплата</label>
                  <input type="number" min={0} value={editForm.salary || ''} onChange={e => setEditForm(p => ({ ...p, salary: Number(e.target.value) }))}
                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm" />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block flex items-center gap-1">
                    <KeyRound className="size-3" /> PIN-код
                  </label>
                  <div className="flex gap-2">
                    <input type="text" maxLength={4} value={editForm.pin} onChange={e => setEditForm(p => ({ ...p, pin: e.target.value.replace(/\D/g, '').slice(0, 4) }))}
                      placeholder="4 цифры"
                      className="flex-1 px-3 py-2 bg-background border border-border rounded-lg text-sm font-mono tracking-widest" />
                    <button type="button" onClick={async () => {
                      try {
                        const pin = await generateUniquePin(user?.restaurantId || '')
                        setEditForm(p => ({ ...p, pin }))
                        toast.success(`PIN: ${pin}`)
                      } catch (e) { toast.error(e instanceof Error ? e.message : 'Ошибка') }
                    }}
                      className="px-3 py-2 text-xs font-medium text-primary border border-primary/30 bg-primary/5 rounded-lg hover:bg-primary/10 transition-colors whitespace-nowrap">
                      Сгенерировать
                    </button>
                  </div>
                </div>
              </div>
            </div>
            <div className="flex gap-2 p-5 border-t border-border">
              <button onClick={() => setEditingEmp(null)} className="flex-1 px-4 py-2.5 text-sm font-medium text-foreground bg-card border border-border rounded-lg hover:bg-muted">
                Отмена
              </button>
              <button onClick={handleSaveEdit} disabled={savingEdit || !editForm.name.trim() || !editForm.username.trim()}
                className="flex-1 px-4 py-2.5 text-sm font-medium text-primary-foreground bg-primary rounded-lg hover:bg-primary/90 disabled:opacity-50">
                {savingEdit ? 'Сохранение...' : 'Сохранить'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── AddUserForm ──────────────────────────────────────────────────────────────
// Локальный state — внутри. memo + стабильные props (см. useCallback в родителе)
// не дают форме ре-рендериться при изменениях в родителе (employees, permMatrix
// и т.п.), а изменения в form'е не ре-рендерят родителя.

type AddUserFormValues = {
  name: string
  username: string
  password: string
  role: UserRoleType
  salary: number
}

type AddUserFormProps = {
  submitting: boolean
  onSubmit: (values: AddUserFormValues) => void
  onCancel: () => void
}

const STAFF_ROLES_LIST: UserRoleType[] = ['manager', 'waiter', 'cashier', 'cook', 'storekeeper', 'accountant', 'other']

const AddUserForm = memo(function AddUserForm({ submitting, onSubmit, onCancel }: AddUserFormProps) {
  const [name, setName] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('1234')
  const [role, setRole] = useState<UserRoleType>('waiter')
  const [salary, setSalary] = useState(0)

  return (
    <div className="bg-card rounded-xl border border-border p-5 space-y-3">
      <h3 className="text-sm font-semibold text-foreground">Новый сотрудник</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        <div>
          <label className="text-xs text-muted-foreground block mb-1">Имя <span className="text-destructive">*</span></label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Иванов Иван" className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground block mb-1">Логин <span className="text-destructive">*</span></label>
          <input value={username} onChange={e => setUsername(e.target.value)} placeholder="ivanov" className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground block mb-1">Пароль</label>
          <input value={password} onChange={e => setPassword(e.target.value)} placeholder="1234" className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground block mb-1">Роль</label>
          <select value={role} onChange={e => setRole(e.target.value as UserRoleType)} className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm">
            {STAFF_ROLES_LIST.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs text-muted-foreground block mb-1">Зарплата</label>
          <input type="number" min={0} value={salary || ''} onChange={e => setSalary(Number(e.target.value))} className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm" />
        </div>
      </div>
      <div className="flex gap-2">
        <button
          onClick={() => onSubmit({ name, username, password, role, salary })}
          disabled={submitting || !name.trim() || !username.trim()}
          className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium disabled:opacity-50">
          {submitting ? 'Добавление...' : 'Добавить'}
        </button>
        <button onClick={onCancel} className="px-3 py-2 text-sm text-muted-foreground">Отмена</button>
      </div>
    </div>
  )
})
