'use client'

import { useState, useEffect, useRef, memo, useCallback, useMemo } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '@/lib/auth-store'
import { formatCurrency, transliterateToUsername } from '@/lib/helpers'
import {
  type User, type UserPermissions, type PermissionKey, type UserRole as UserRoleType,
  ROLE_LABELS, PERMISSION_GROUPS, PERMISSION_LABELS, ALL_PERMISSIONS,
  ROLE_DEFAULT_PERMISSIONS, buildNavFromPermissions, COMMON_STAFF_POSITIONS,
} from '@/lib/types'
import {
  type User as UserType2, type UserPermissions as UP2,
  ALL_STATIONS, STATION_LABELS, STATION_ICONS, type MenuStation,
} from '@/lib/types'
import { fetchUsersByRestaurant, updateUserPermissions, createUserForRestaurant, deleteUser, updateUser, generateUniquePin } from '@/lib/queries'
import { fetchBranches, fetchNetworkStaff, type Branch, type NetworkStaffMember } from '@/lib/queries/transfers'
import { requestCreateEmployeeRelay, requestUpdateEmployeeIdentity, type EmployeeRelayRole } from '@/lib/queries/employee-relay'
import { useBranchView } from '@/hooks/use-branch-view'
import { V4Error } from '@/lib/api'
import { Shield, Save, RotateCcw, Check, Minus, Plus, Trash2, Users, Search, Pencil, Grid3X3, List, X, KeyRound, ChevronsUpDown, Wallet, Network } from 'lucide-react'
import { toast } from 'sonner'
import { humanizeError } from '@/lib/errors'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from '@/components/ui/command'

type PermMap = Record<string, Record<string, boolean>>
type Tab = 'staff' | 'matrix'

export default function UserPermissionsPage() {
  const { user, restaurant, canDo } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const isBranchView = useBranchView()
  // central = может управлять персоналом ДРУГИХ филиалов сети через relay
  // (097) — учётка физически появляется в БД филиала своим пулером, не сразу.
  const isCentral = restaurant?.kind === 'central_warehouse' && !isBranchView
  // Точечная ссылка с finance/payroll (Фаза 4, ?highlight=<id>) — подсвечиваем
  // и скроллим к сотруднику, откуда бы он ни пришёл (свой или филиальный).
  // useEffect, а не lazy useState-инициализатор: страница может остаться
  // смонтированной между переходами (тот же компонент, новый query) —
  // инициализатор useState тогда просто не перечитался бы повторно.
  const [highlightId, setHighlightId] = useState<string | null>(null)
  useEffect(() => {
    const h = searchParams.get('highlight')
    if (h) setHighlightId(h)
  }, [searchParams])
  const [employees, setEmployees] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [permMatrix, setPermMatrix] = useState<PermMap>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [dirty, setDirty] = useState<Set<string>>(new Set())
  const [tab, setTab] = useState<Tab>('staff')
  const [search, setSearch] = useState('')

  // Персонал ДРУГИХ филиалов сети (только central) — просмотр + правка
  // identity-полей через relay. Ставку/доп.смены меняют в Финансы → Зарплата
  // (Фаза 4) — это разные права (payroll.manage), поэтому 403 тут не ошибка,
  // а просто «этому пользователю сетевой раздел зарплаты не открыт».
  const [branches, setBranches] = useState<Branch[]>([])
  const [branchStaff, setBranchStaff] = useState<NetworkStaffMember[]>([])
  const loadBranchStaff = useCallback(async () => {
    if (!isCentral) return
    try {
      const [b, ns] = await Promise.all([fetchBranches(), fetchNetworkStaff()])
      setBranches(b)
      setBranchStaff(ns.staff.filter(m => m.branchId && m.branchId !== user?.restaurantId))
    } catch (e) {
      if (!(e instanceof V4Error && e.status === 403)) {
        toast.error(humanizeError(e, 'Не удалось загрузить сотрудников филиалов'))
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCentral, user?.restaurantId])
  useEffect(() => { loadBranchStaff() }, [loadBranchStaff])

  // Скролл + автогашение — ОДНИМ эффектом (см. тот же приём в finance/payroll):
  // независимый таймер гашения мог сработать РАНЬШЕ, чем страница успевала
  // отрисовать строку, и подсветка не появлялась вовсе. branchStaff — своим,
  // независимым от loading запросом (loadBranchStaff): без него в зависимостях
  // эффект успевал отработать до того, как филиальная секция вообще появится
  // в DOM (getElementById → null навсегда, сам DOM-поиск не реактивен).
  useEffect(() => {
    if (!highlightId || loading) return
    document.getElementById(`staff-row-${highlightId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    const t = setTimeout(() => setHighlightId(null), 6000)
    return () => clearTimeout(t)
  }, [highlightId, loading, branchStaff])

  // Редактирование identity сотрудника ДРУГОГО филиала (через relay).
  const [editingBranchEmp, setEditingBranchEmp] = useState<NetworkStaffMember | null>(null)
  const [branchEditForm, setBranchEditForm] = useState({ name: '', username: '', role: 'waiter' as UserRoleType, position: '', birthDate: '', station: '', pin: '' })
  const [savingBranchEdit, setSavingBranchEdit] = useState(false)

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

  const STAFF_ROLES: UserRoleType[] = ['manager', 'waiter', 'cashier', 'cook', 'storekeeper', 'accountant', 'kiosk', 'checkin', 'other']

  const loadEmployees = async () => {
    if (!user?.restaurantId) return
    const data = await fetchUsersByRestaurant(user.restaurantId)
    // Show all users including owner (for PIN management), exclude only superadmin
    const emps = data.filter(u => u.role !== 'superadmin')
    setEmployees(emps)
    const matrix: PermMap = {}
    for (const emp of emps) {
      const saved = emp.permissions?.actions && Object.keys(emp.permissions.actions).length > 0 ? emp.permissions.actions : null
      // Defensive: role может оказаться не в карте (legacy/migrated 'deleted').
    const defaults = ROLE_DEFAULT_PERMISSIONS[emp.role]?.actions ?? {}
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

  // Подсказки для комбобокса «Должность»: стандартный набор + всё, что уже
  // реально сохранено у сотрудников ресторана. Как только должность сохранена
  // хотя бы раз — она сама появляется здесь для следующих сотрудников.
  // useMemo на [employees] — ссылка стабильна между не относящимися к этому
  // ре-рендерами (тогглы прав и т.п.), иначе сломает memo() у AddUserForm.
  const knownPositions = useMemo(() => {
    const used = employees.map(e => (e.position || '').trim()).filter(Boolean)
    return Array.from(new Set([...COMMON_STAFF_POSITIONS, ...used])).sort((a, b) => a.localeCompare(b, 'ru'))
  }, [employees])

  // ─── Permission matrix actions ──────────────────────────────────────────
  const togglePerm = (userId: string, key: PermissionKey) => {
    setPermMatrix(prev => ({ ...prev, [userId]: { ...prev[userId], [key]: !prev[userId]?.[key] } }))
    setDirty(prev => new Set(prev).add(userId))
  }

  const resetUser = (emp: User) => {
    // Defensive: role может оказаться не в карте (legacy/migrated 'deleted').
    const defaults = ROLE_DEFAULT_PERMISSIONS[emp.role]?.actions ?? {}
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
      toast.error(humanizeError(e, 'Ошибка сохранения'))
    } finally { setSaving(null) }
  }

  const saveAll = async () => {
    for (const emp of employees.filter(e => dirty.has(e.id))) { await saveUser(emp) }
  }

  // ─── Staff CRUD ─────────────────────────────────────────────────────────
  // Принимает form values из AddUserForm (локальный state там, не здесь).
  // Стабильная ссылка через useCallback — чтобы memo-обёртка реально работала.
  const handleAddUser = useCallback(async (form: AddUserFormValues) => {
    if (!form.name.trim() || !user?.restaurantId) return
    setAddingUser(true)
    try {
      if (form.branchId && form.branchId !== user.restaurantId) {
        // Другой филиал сети — central не может писать в его БД напрямую,
        // ставим команду в очередь (097): реально появится своим пулером.
        const action = await requestCreateEmployeeRelay({
          branchId: form.branchId,
          name: form.name.trim(),
          username: form.username.trim().toLowerCase() || undefined,
          // AddUserForm предлагает только STAFF_ROLES_LIST — тот же набор,
          // что EmployeeRelayRole (без owner/superadmin) — просто уже
          // выражен через более широкий UserRoleType, общий для всей формы.
          role: form.role as EmployeeRelayRole,
          position: form.position.trim() || undefined,
          pin: form.pin || undefined,
        })
        const assignedPin = typeof action.payload?.pin === 'string' ? action.payload.pin : undefined
        toast.success(
          `${form.name.trim()} отправлен на филиал — появится там в течение ~30 секунд.`
          + (assignedPin ? ` PIN: ${assignedPin}` : ''),
        )
      } else {
        await createUserForRestaurant({
          name: form.name.trim(),
          username: form.username.trim().toLowerCase(),
          role: form.role,
          restaurantId: user.restaurantId,
          salary: form.salary,
          pin: form.pin || undefined,
          position: form.position.trim() || undefined,
        })
        toast.success(`${form.name.trim()} добавлен`)
      }
      setShowAddUser(false)
      await loadEmployees()
      await loadBranchStaff()
    } catch (e) {
      console.error('[createUser]', e)
      toast.error(humanizeError(e, 'Ошибка'))
    } finally {
      setAddingUser(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.restaurantId, loadBranchStaff])

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
      const msg = humanizeError(e, 'Ошибка удаления')
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
      toast.error(humanizeError(e, 'Ошибка'))
    } finally { setSavingEdit(false) }
  }

  // ─── Сотрудник ДРУГОГО филиала: правка identity через relay (097) ───────
  const openEditBranchEmployee = (m: NetworkStaffMember) => {
    setEditingBranchEmp(m)
    setBranchEditForm({
      name: m.name,
      username: m.username || '',
      role: (m.role as UserRoleType) || 'waiter',
      position: m.position || '',
      birthDate: m.birthDate || '',
      station: m.station || '',
      pin: '',
    })
  }

  const handleSaveBranchEdit = async () => {
    if (!editingBranchEmp) return
    setSavingBranchEdit(true)
    try {
      await requestUpdateEmployeeIdentity(editingBranchEmp.id, {
        name: branchEditForm.name.trim(),
        username: branchEditForm.username.trim().toLowerCase(),
        // Диалог предлагает те же STAFF_ROLES (без owner/superadmin), что и
        // EmployeeRelayRole — см. комментарий у AddUserForm выше.
        role: branchEditForm.role as EmployeeRelayRole,
        position: branchEditForm.position.trim(),
        birthDate: branchEditForm.birthDate || undefined,
        station: branchEditForm.station || undefined,
        ...(branchEditForm.pin.trim() ? { pin: branchEditForm.pin.trim() } : {}),
      })
      toast.success(`Изменения для ${branchEditForm.name} отправлены на филиал «${editingBranchEmp.branchName}» — применятся в течение ~30 секунд`)
      setEditingBranchEmp(null)
      await loadBranchStaff()
    } catch (e) {
      toast.error(humanizeError(e, 'Ошибка'))
    } finally { setSavingBranchEdit(false) }
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
          existingPositions={knownPositions}
          ownRestaurantId={user?.restaurantId || ''}
          branches={isCentral ? branches : []}
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
              p => (matrix[p] ?? false) !== ((ROLE_DEFAULT_PERMISSIONS[emp.role]?.actions ?? {})[p] ?? false)
            )

            return (
              <div key={emp.id} id={`staff-row-${emp.id}`}
                className={`bg-card rounded-xl border overflow-hidden ${highlightId === emp.id ? 'border-primary ring-1 ring-primary/40' : 'border-border'}`}>
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
                            const defaultVal = (ROLE_DEFAULT_PERMISSIONS[emp.role]?.actions ?? {})[key] ?? false
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

      {/* ═══ Сотрудники ДРУГИХ филиалов сети (только central) ═══
          Отдельная секция, не влита в общий filtered-список: другая форма
          данных (NetworkStaffMember, не User) и другой набор действий — без
          матрицы прав, без удаления (relay их не поддерживает), ставка и
          доп.смены — в Финансы → Зарплата (Фаза 4). */}
      {tab === 'staff' && isCentral && branchStaff.length > 0 && (
        <div className="space-y-2 pt-2">
          <div className="flex items-center gap-2">
            <Network className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground">Сотрудники филиалов</h2>
            <span className="bg-muted px-1.5 py-0.5 rounded text-[10px] font-bold text-muted-foreground">{branchStaff.length}</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Изменения применяются на филиале не сразу — в течение ~30 секунд. Ставку и доп. смены меняйте в Финансы → Зарплата.
          </p>
          <div className="space-y-2">
            {branchStaff.map(m => (
              <div key={m.id} id={`staff-row-${m.id}`}
                className={`bg-card rounded-xl border overflow-hidden ${highlightId === m.id ? 'border-primary ring-1 ring-primary/40' : 'border-border'}`}>
                <div className="flex items-center gap-4 p-4">
                  <div className="size-10 rounded-xl bg-muted flex items-center justify-center shrink-0 text-sm font-bold text-muted-foreground">
                    {m.name.charAt(0)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-foreground text-sm">{m.name}</span>
                      <span className="text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded">{ROLE_LABELS[m.role as UserRoleType] || m.role}</span>
                      {m.position && <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded">{m.position}</span>}
                      <span className="text-[10px] bg-blue-500/10 text-blue-600 dark:text-blue-400 px-1.5 py-0.5 rounded font-medium">{m.branchName}</span>
                    </div>
                    {m.username && <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">@{m.username}</div>}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => navigate(`/finance/payroll?highlight=${m.id}`)} title="Зарплата — в разделе Финансы"
                      className="p-2 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors">
                      <Wallet className="size-4" />
                    </button>
                    <button onClick={() => openEditBranchEmployee(m)} title="Редактировать"
                      className="p-2 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors">
                      <Pencil className="size-4" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
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
          if (roleEmps.length === 0) return (ROLE_DEFAULT_PERMISSIONS[role]?.actions ?? {})[key] ? 'all' : 'none'
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
                          const defaultVal = (ROLE_DEFAULT_PERMISSIONS[role]?.actions ?? {})[key] === true
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
                  <PositionCombobox value={editForm.position} onChange={v => setEditForm(p => ({ ...p, position: v }))}
                    suggestions={knownPositions} placeholder="Салатчик (старший)" />
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
                      } catch (e) { toast.error(humanizeError(e, 'Ошибка')) }
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
              {/* username НЕ обязателен: логин везде по PIN (LoginByPIN), поле
                  чисто косметическое (@username в списке). Владелец,
                  созданный через setup-central.sh (Bootstrap), не получает
                  username вообще — требование непустого поля здесь навсегда
                  блокировало Сохранить, в том числе смену PIN. */}
              <button onClick={handleSaveEdit} disabled={savingEdit || !editForm.name.trim()}
                className="flex-1 px-4 py-2.5 text-sm font-medium text-primary-foreground bg-primary rounded-lg hover:bg-primary/90 disabled:opacity-50">
                {savingEdit ? 'Сохранение...' : 'Сохранить'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ Edit Branch Employee Dialog (identity через relay, 097) ═══ */}
      {editingBranchEmp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setEditingBranchEmp(null)}>
          <div className="bg-card rounded-2xl border border-border shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-5 border-b border-border">
              <div>
                <h2 className="text-lg font-bold text-foreground">Редактировать сотрудника</h2>
                <p className="text-xs text-muted-foreground mt-0.5">Филиал «{editingBranchEmp.branchName}» · применится через ~30 секунд</p>
              </div>
              <button onClick={() => setEditingBranchEmp(null)} className="p-1 text-muted-foreground hover:text-foreground"><X className="size-5" /></button>
            </div>
            <div className="p-5 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">ФИО</label>
                  <input value={branchEditForm.name} onChange={e => setBranchEditForm(p => ({ ...p, name: e.target.value }))}
                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm" />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Логин</label>
                  <input value={branchEditForm.username} onChange={e => setBranchEditForm(p => ({ ...p, username: e.target.value }))}
                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Роль</label>
                  <select value={branchEditForm.role} onChange={e => setBranchEditForm(p => ({ ...p, role: e.target.value as UserRoleType }))}
                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm">
                    {STAFF_ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Должность</label>
                  <PositionCombobox value={branchEditForm.position} onChange={v => setBranchEditForm(p => ({ ...p, position: v }))}
                    suggestions={knownPositions} placeholder="Официант" />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Дата рождения</label>
                  <input type="date" value={branchEditForm.birthDate} onChange={e => setBranchEditForm(p => ({ ...p, birthDate: e.target.value }))}
                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm" />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Станция</label>
                  <select value={branchEditForm.station} onChange={e => setBranchEditForm(p => ({ ...p, station: e.target.value }))}
                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm">
                    <option value="">— нет —</option>
                    {ALL_STATIONS.map(s => <option key={s} value={s}>{STATION_ICONS[s]} {STATION_LABELS[s]}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block flex items-center gap-1">
                    <KeyRound className="size-3" /> PIN-код
                  </label>
                  <input type="text" maxLength={4} value={branchEditForm.pin} onChange={e => setBranchEditForm(p => ({ ...p, pin: e.target.value.replace(/\D/g, '').slice(0, 4) }))}
                    placeholder="оставить пустым — без изменений"
                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm font-mono tracking-widest" />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Оклад/ставку и доп. смены меняйте в{' '}
                <button type="button" onClick={() => { setEditingBranchEmp(null); navigate(`/finance/payroll?highlight=${editingBranchEmp.id}`) }} className="text-primary hover:underline">
                  Финансы → Зарплата
                </button>.
              </p>
            </div>
            <div className="flex gap-2 p-5 border-t border-border">
              <button onClick={() => setEditingBranchEmp(null)} className="flex-1 px-4 py-2.5 text-sm font-medium text-foreground bg-card border border-border rounded-lg hover:bg-muted">
                Отмена
              </button>
              <button onClick={handleSaveBranchEdit} disabled={savingBranchEdit || !branchEditForm.name.trim()}
                className="flex-1 px-4 py-2.5 text-sm font-medium text-primary-foreground bg-primary rounded-lg hover:bg-primary/90 disabled:opacity-50">
                {savingBranchEdit ? 'Отправка...' : 'Сохранить'}
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
  role: UserRoleType
  salary: number
  position: string
  pin: string
  /** Свой restaurantId — локальное добавление; другой id из branches — relay (097). */
  branchId: string
}

type AddUserFormProps = {
  submitting: boolean
  onSubmit: (values: AddUserFormValues) => void
  onCancel: () => void
  existingPositions: string[]
  ownRestaurantId: string
  /** Другие филиалы сети — пусто, если не central (select тогда не показываем). */
  branches: Branch[]
}

const STAFF_ROLES_LIST: UserRoleType[] = ['manager', 'waiter', 'cashier', 'cook', 'storekeeper', 'accountant', 'kiosk', 'checkin', 'other']

// Используем UNCONTROLLED inputs (defaultValue + native <form> + FormData).
// Раньше controlled-inputs с useState внутри memo-обёртки в редких случаях
// «зависали»: реальная причина — поведение Chromium в Electron + WebKit
// сочетание input + контекст-провайдер пересоздающий value. Uncontrolled
// inputs полностью иммунны к re-render → пользовательский ввод никогда не
// теряется. На submit читаем все поля одним FormData(form).
// Исключение — «Должность»/«Филиал»/PIN: не нативные form-элементы или
// нужен доступ к текущему значению до submit (транслитерация, генерация
// PIN). Ре-рендер от них локален для AddUserForm и не задевает родителя —
// список сотрудников/матрица прав не фризятся.
//
// Пароль — поля нет вообще: реальный вход в кассу только по PIN
// (LoginByPIN), бэк дефолтит password='1234' и это никогда не используется.
const AddUserForm = memo(function AddUserForm({ submitting, onSubmit, onCancel, existingPositions, ownRestaurantId, branches }: AddUserFormProps) {
  const [position, setPosition] = useState('')
  const [branchId, setBranchId] = useState(ownRestaurantId)
  const [pin, setPin] = useState('')
  const [generatingPin, setGeneratingPin] = useState(false)
  const usernameRef = useRef<HTMLInputElement>(null)
  const usernameTouched = useRef(false)
  const isLocal = !branchId || branchId === ownRestaurantId

  // Логин автоподставляется транслитерацией ФИО, пока пользователь не
  // тронул поле сам — после первой ручной правки автоподстановка больше не
  // перезаписывает то, что уже введено.
  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (usernameRef.current && !usernameTouched.current) {
      usernameRef.current.value = transliterateToUsername(e.target.value)
    }
  }

  const handleGeneratePin = async () => {
    // Только для своего ресторана — GeneratePIN намеренно не расширен на
    // чужой tenant (Фаза 1); для другого филиала PIN подбирает central сам
    // внутри RequestCreate (097), результат приходит после отправки формы.
    if (!isLocal || !ownRestaurantId) return
    setGeneratingPin(true)
    try {
      setPin(await generateUniquePin(ownRestaurantId))
    } catch (e) {
      toast.error(humanizeError(e, 'Ошибка'))
    } finally {
      setGeneratingPin(false)
    }
  }

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    onSubmit({
      name: String(fd.get('name') || '').trim(),
      username: String(fd.get('username') || '').trim(),
      role: (String(fd.get('role') || 'waiter')) as UserRoleType,
      salary: Number(fd.get('salary') || 0),
      position,
      pin,
      branchId: isLocal ? ownRestaurantId : branchId,
    })
  }
  return (
    <form onSubmit={handleSubmit} className="bg-card rounded-xl border border-border p-5 space-y-3">
      <h3 className="text-sm font-semibold text-foreground">Новый сотрудник</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
        {branches.length > 0 && (
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Филиал</label>
            <select value={branchId} onChange={e => setBranchId(e.target.value)} className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm">
              <option value={ownRestaurantId}>Свой (центральный)</option>
              {branches.filter(b => b.id !== ownRestaurantId).map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
        )}
        <div>
          <label className="text-xs text-muted-foreground block mb-1">Имя <span className="text-destructive">*</span></label>
          <input name="name" required autoFocus defaultValue="" placeholder="Иванов Иван" onChange={handleNameChange} className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground block mb-1">Логин</label>
          <input name="username" ref={usernameRef} onChange={() => { usernameTouched.current = true }} defaultValue="" placeholder="ivanov" className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground block mb-1">Роль</label>
          <select name="role" defaultValue="waiter" className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm">
            {STAFF_ROLES_LIST.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs text-muted-foreground block mb-1">Должность</label>
          <PositionCombobox value={position} onChange={setPosition} suggestions={existingPositions} placeholder="Официант" />
        </div>
        {isLocal && (
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Зарплата</label>
            <input name="salary" type="number" min={0} defaultValue="" className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm" />
          </div>
        )}
        <div>
          <label className="text-xs text-muted-foreground block mb-1 flex items-center gap-1"><KeyRound className="size-3" />PIN</label>
          <div className="flex gap-2">
            <input value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))} maxLength={4}
              placeholder={isLocal ? '4 цифры' : 'подберёт филиал'}
              className="flex-1 px-3 py-2 bg-background border border-border rounded-lg text-sm font-mono tracking-widest" />
            {isLocal && (
              <button type="button" onClick={handleGeneratePin} disabled={generatingPin}
                className="px-3 py-2 text-xs font-medium text-primary border border-primary/30 bg-primary/5 rounded-lg hover:bg-primary/10 transition-colors whitespace-nowrap disabled:opacity-50">
                {generatingPin ? '...' : 'Сгенерировать'}
              </button>
            )}
          </div>
        </div>
      </div>
      {!isLocal && (
        <p className="text-xs text-muted-foreground">
          Сотрудник появится на филиале в течение ~30 секунд. Пароль не нужен — вход по PIN.
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" disabled={submitting}
          className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium disabled:opacity-50">
          {submitting ? 'Добавление...' : 'Добавить'}
        </button>
        <button type="button" onClick={onCancel} className="px-3 py-2 text-sm text-muted-foreground">Отмена</button>
      </div>
    </form>
  )
})

// ─── PositionCombobox ───────────────────────────────────────────────────────
// «Должность» — выбери из списка или впиши свою. Список = стандартный набор
// (COMMON_STAFF_POSITIONS) + всё, что уже реально сохранено у сотрудников
// ресторана (knownPositions в родителе). Отдельно сохранять новую должность
// никуда не нужно: как только сотрудник с ней сохранён, она сама попадёт в
// knownPositions при следующем открытии формы (учится из employees).
function PositionCombobox({ value, onChange, suggestions, placeholder }: {
  value: string
  onChange: (v: string) => void
  suggestions: string[]
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const filtered = q ? suggestions.filter(s => s.toLowerCase().includes(q)) : suggestions
  const hasExactMatch = suggestions.some(s => s.toLowerCase() === q)

  return (
    <Popover open={open} onOpenChange={o => { setOpen(o); setQuery(o ? value : '') }}>
      <PopoverTrigger asChild>
        <button type="button"
          className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-left flex items-center justify-between gap-2 hover:bg-muted/40 transition-colors">
          <span className={`truncate ${value ? 'text-foreground' : 'text-muted-foreground'}`}>{value || placeholder || 'Выбрать или вписать...'}</span>
          <ChevronsUpDown className="size-3.5 text-muted-foreground shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="p-0 w-[var(--radix-popover-trigger-width)]">
        <Command shouldFilter={false}>
          <CommandInput value={query} onValueChange={setQuery} placeholder="Найти или вписать новую..." />
          <CommandList>
            <CommandEmpty>Не найдено</CommandEmpty>
            <CommandGroup>
              {filtered.map(s => (
                <CommandItem key={s} value={s} onSelect={() => { onChange(s); setOpen(false) }}>
                  <Check className={`mr-2 size-4 ${value === s ? 'opacity-100' : 'opacity-0'}`} />
                  {s}
                </CommandItem>
              ))}
            </CommandGroup>
            {query.trim() && !hasExactMatch && (
              <CommandGroup>
                <CommandItem value={`__create__${query.trim()}`} onSelect={() => { onChange(query.trim()); setOpen(false) }}>
                  <Plus className="mr-2 size-4" />
                  Добавить «{query.trim()}»
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
