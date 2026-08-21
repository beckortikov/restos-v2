import { api, unwrap } from './_client'

// Multi-branch: перемещения между филиалами + сетевой каталог номенклатуры
// (ADR-003, Фаза 1).

export interface Branch {
  id: string
  name: string
  kind?: 'outlet' | 'central_warehouse' | null
}

export interface Nomenclature {
  id: string
  name: string
  unit?: string | null
  category?: string | null
}

export interface TransferLine {
  id: string
  ingredientId?: string | null
  nomenclatureId?: string | null
  ingredientName?: string | null
  qty: number
  unit?: string | null
  costPerUnit: number
}

export interface Transfer {
  id: string
  fromRestaurantId?: string | null
  toRestaurantId?: string | null
  transferNumber?: number | null
  status: 'draft' | 'sent' | 'received' | 'cancelled'
  note?: string | null
  sentAt?: string | null
  receivedAt?: string | null
  createdAt?: string | null
  createdBy?: string | null
  receivedBy?: string | null
  lines: TransferLine[]
}

function mapLine(r: any): TransferLine {
  return {
    id: r.id,
    ingredientId: r.ingredient_id,
    nomenclatureId: r.nomenclature_id,
    ingredientName: r.ingredient_name,
    qty: Number(r.qty ?? 0),
    unit: r.unit,
    costPerUnit: Number(r.cost_per_unit ?? 0),
  }
}

function mapTransfer(r: any): Transfer {
  return {
    id: r.id,
    fromRestaurantId: r.from_restaurant_id,
    toRestaurantId: r.to_restaurant_id,
    transferNumber: r.transfer_number,
    status: r.status,
    note: r.note,
    sentAt: r.sent_at,
    receivedAt: r.received_at,
    createdAt: r.created_at,
    createdBy: r.created_by,
    receivedBy: r.received_by,
    lines: Array.isArray(r.lines) ? r.lines.map(mapLine) : [],
  }
}

// ─── Филиалы сети ────────────────────────────────────────────────────────────
export async function fetchBranches(): Promise<Branch[]> {
  const env: any = await unwrap(api.GET('/api/v1/network/branches'))
  const rows: any[] = Array.isArray(env?.data) ? env.data : []
  return rows.map(r => ({ id: r.id, name: r.name, kind: r.kind }))
}

// ─── Сводка владельцу по сети (Фаза 4) ─────────────────────────────────────────
export interface BranchSummary {
  id: string
  name: string
  kind?: 'outlet' | 'central_warehouse' | null
  revenue: number
}
export interface NetworkSummary {
  totalRevenue: number
  branches: BranchSummary[]
}

export async function createNetwork(name?: string): Promise<{ id: string; name: string }> {
  const r: any = await unwrap(api.POST('/api/v1/network', { body: { name } as any }))
  return { id: r.id, name: r.name }
}

// ─── Приглашения филиалов (ADR-003, продолжение) ───────────────────────────
// Central генерирует одноразовый код — филиал вставляет его на странице
// «Синхронизация» (joinNetwork в sync-settings.ts), без ручного SQL/секретов.
export interface NetworkInvite {
  id: string
  label?: string | null
  code: string
  pairingUrl: string
  expiresAt: string
  usedAt?: string | null
  usedByRestaurantName?: string | null
}
function mapInvite(r: any): NetworkInvite {
  return {
    id: r.id,
    label: r.label,
    code: r.code,
    pairingUrl: r.pairing_url,
    expiresAt: r.expires_at,
    usedAt: r.used_at,
    usedByRestaurantName: r.used_by_restaurant_name,
  }
}
export async function fetchNetworkInvites(): Promise<NetworkInvite[]> {
  const env: any = await unwrap(api.GET('/api/v1/network/invites'))
  const rows: any[] = Array.isArray(env?.data) ? env.data : []
  return rows.map(mapInvite)
}
export async function createNetworkInvite(input: { label?: string; publicUrl?: string }): Promise<NetworkInvite> {
  const r: any = await unwrap(api.POST('/api/v1/network/invites', {
    body: { label: input.label, public_url: input.publicUrl } as any,
  }))
  return mapInvite(r)
}
export async function revokeNetworkInvite(id: string): Promise<void> {
  await unwrap(api.DELETE('/api/v1/network/invites/{id}', { params: { path: { id } } }))
}

// ─── Мастер-меню сети (ADR-004) ────────────────────────────────────────────────
export interface NetworkMenuItem {
  id: string
  name: string
  category?: string | null
  basePrice: number
  station?: string | null
  unit?: string | null
  emoji?: string | null
}
export interface NetworkMenuInput {
  name: string
  category?: string
  basePrice?: number
  station?: string
  unit?: string
  emoji?: string
}
function mapNetMenu(r: any): NetworkMenuItem {
  return { id: r.id, name: r.name, category: r.category, basePrice: Number(r.base_price ?? 0), station: r.station, unit: r.unit, emoji: r.emoji }
}
function netMenuBody(i: NetworkMenuInput) {
  return {
    name: i.name,
    category: i.category,
    base_price: i.basePrice != null ? String(i.basePrice) : undefined,
    station: i.station,
    unit: i.unit,
    emoji: i.emoji,
  }
}
export async function fetchNetworkMenu(): Promise<NetworkMenuItem[]> {
  const env: any = await unwrap(api.GET('/api/v1/network/menu'))
  const rows: any[] = Array.isArray(env?.data) ? env.data : []
  return rows.map(mapNetMenu)
}
export async function createNetworkMenuItem(input: NetworkMenuInput): Promise<NetworkMenuItem> {
  const r: any = await unwrap(api.POST('/api/v1/network/menu', { body: netMenuBody(input) as any }))
  return mapNetMenu(r)
}
export async function updateNetworkMenuItem(id: string, input: NetworkMenuInput): Promise<NetworkMenuItem> {
  const r: any = await unwrap(api.PATCH('/api/v1/network/menu/{id}', { params: { path: { id } }, body: netMenuBody(input) as any }))
  return mapNetMenu(r)
}

export async function setBranchKind(restaurantId: string, kind: 'outlet' | 'central_warehouse'): Promise<void> {
  await unwrap(api.POST('/api/v1/network/branches/{id}/kind', {
    params: { path: { id: restaurantId } },
    body: { kind } as any,
  }))
}

/**
 * detachBranch — отключить филиал от сети (ADR-003, Фаза У).
 * Данные, которые он уже прислал, остаются в базе: филиал лишь перестаёт
 * входить в состав сети (пропадает из списков, отчётов и down-sync).
 */
export async function detachBranch(restaurantId: string): Promise<void> {
  await unwrap(api.POST('/api/v1/network/branches/{id}/detach', {
    params: { path: { id: restaurantId } },
  }))
}

export async function fetchNetworkSummary(opts?: { from?: string; to?: string }): Promise<NetworkSummary> {
  const query: Record<string, string> = {}
  if (opts?.from) query.from = opts.from
  if (opts?.to) query.to = opts.to
  const r: any = await unwrap(api.GET('/api/v1/network/summary', { params: { query: query as any } }))
  return {
    totalRevenue: Number(r?.total_revenue ?? 0),
    branches: Array.isArray(r?.branches)
      ? r.branches.map((b: any) => ({ id: b.id, name: b.name, kind: b.kind, revenue: Number(b.revenue ?? 0) }))
      : [],
  }
}

// ─── Ф8: сетевые консолидированные отчёты (итог + разбивка по филиалам) ───────
export interface PnLAmounts {
  revenue: number
  cogs: number
  writeoffs: number
  supplyExpenses: number
  grossProfit: number
  ordersCount: number
}
export interface NetworkPnLBranch extends PnLAmounts {
  id: string
  name: string
  kind?: 'outlet' | 'central_warehouse' | null
}
export interface NetworkPnL {
  total: PnLAmounts
  branches: NetworkPnLBranch[]
}
function mapPnLAmounts(r: any): PnLAmounts {
  return {
    revenue: Number(r?.revenue ?? 0),
    cogs: Number(r?.cogs ?? 0),
    writeoffs: Number(r?.writeoffs ?? 0),
    supplyExpenses: Number(r?.supply_expenses ?? 0),
    grossProfit: Number(r?.gross_profit ?? 0),
    ordersCount: Number(r?.orders_count ?? 0),
  }
}
export async function fetchNetworkPnL(opts?: { from?: string; to?: string }): Promise<NetworkPnL> {
  const query: Record<string, string> = {}
  if (opts?.from) query.from = opts.from
  if (opts?.to) query.to = opts.to
  const r: any = await unwrap(api.GET('/api/v1/network/pnl', { params: { query: query as any } }))
  return {
    total: mapPnLAmounts(r?.total),
    branches: Array.isArray(r?.branches)
      ? r.branches.map((b: any) => ({ id: b.id, name: b.name, kind: b.kind, ...mapPnLAmounts(b) }))
      : [],
  }
}

export interface CashflowAmounts {
  in: number
  out: number
  net: number
}
export interface NetworkCashflowBranch extends CashflowAmounts {
  id: string
  name: string
  kind?: 'outlet' | 'central_warehouse' | null
}
export interface NetworkCashflow {
  total: CashflowAmounts
  branches: NetworkCashflowBranch[]
}
function mapCashflowAmounts(r: any): CashflowAmounts {
  return { in: Number(r?.in ?? 0), out: Number(r?.out ?? 0), net: Number(r?.net ?? 0) }
}
export async function fetchNetworkCashflow(opts?: { from?: string; to?: string }): Promise<NetworkCashflow> {
  const query: Record<string, string> = {}
  if (opts?.from) query.from = opts.from
  if (opts?.to) query.to = opts.to
  const r: any = await unwrap(api.GET('/api/v1/network/cashflow', { params: { query: query as any } }))
  return {
    total: mapCashflowAmounts(r?.total),
    branches: Array.isArray(r?.branches)
      ? r.branches.map((b: any) => ({ id: b.id, name: b.name, kind: b.kind, ...mapCashflowAmounts(b) }))
      : [],
  }
}

export interface NetworkWarehouseBranch {
  id: string
  name: string
  kind?: 'outlet' | 'central_warehouse' | null
  value: number
}
export interface NetworkWarehouse {
  totalValue: number
  branches: NetworkWarehouseBranch[]
}
export async function fetchNetworkWarehouse(): Promise<NetworkWarehouse> {
  const r: any = await unwrap(api.GET('/api/v1/network/warehouse'))
  return {
    totalValue: Number(r?.total_value ?? 0),
    branches: Array.isArray(r?.branches)
      ? r.branches.map((b: any) => ({ id: b.id, name: b.name, kind: b.kind, value: Number(b.value ?? 0) }))
      : [],
  }
}

export interface NetworkAccountRow {
  id: string
  name?: string | null
  type?: string | null
  balance: number
  isEnabled: boolean
  branchId: string
  branchName: string
  branchKind?: 'outlet' | 'central_warehouse' | null
}
export interface NetworkAccounts {
  totalBalance: number
  accounts: NetworkAccountRow[]
}
export async function fetchNetworkAccounts(): Promise<NetworkAccounts> {
  const r: any = await unwrap(api.GET('/api/v1/network/accounts'))
  return {
    totalBalance: Number(r?.total_balance ?? 0),
    accounts: Array.isArray(r?.accounts)
      ? r.accounts.map((a: any) => ({
          id: a.id,
          name: a.name,
          type: a.type,
          balance: Number(a.balance ?? 0),
          isEnabled: a.is_enabled !== false,
          branchId: a.restaurant_id,
          branchName: a.branch_name,
          branchKind: a.branch_kind,
        }))
      : [],
  }
}

// ─── Персонал сети (Фаза П) ────────────────────────────────────────────────────
// Только чтение: филиал — авторитет по своим учёткам, правка из центра была бы
// перезаписана его следующим пушем.

export interface NetworkStaffMember {
  id: string
  name: string
  role: string
  position?: string | null
  phone?: string | null
  payType: 'monthly' | 'daily'
  salary: number
  dailyRate: number
  branchId?: string | null
  branchName: string
  branchKind?: 'outlet' | 'central_warehouse' | null
}

export interface NetworkStaffBranch {
  id: string
  name: string
  kind?: 'outlet' | 'central_warehouse' | null
  count: number
}

export interface NetworkStaff {
  totalCount: number
  branches: NetworkStaffBranch[]
  staff: NetworkStaffMember[]
}

export async function fetchNetworkStaff(): Promise<NetworkStaff> {
  const r: any = await unwrap(api.GET('/api/v1/network/staff'))
  return {
    totalCount: Number(r?.total_count ?? 0),
    branches: Array.isArray(r?.branches)
      ? r.branches.map((b: any) => ({ id: b.id, name: b.name, kind: b.kind, count: Number(b.count ?? 0) }))
      : [],
    staff: Array.isArray(r?.staff)
      ? r.staff.map((u: any) => ({
          id: u.id,
          name: u.name ?? '',
          role: u.role ?? '',
          position: u.position,
          phone: u.phone,
          payType: u.pay_type === 'daily' ? 'daily' : 'monthly',
          salary: Number(u.salary ?? 0),
          dailyRate: Number(u.daily_rate ?? 0),
          branchId: u.restaurant_id,
          branchName: u.branch_name ?? '',
          branchKind: u.branch_kind,
        }))
      : [],
  }
}

/**
 * payBranchSalary — выплата сотруднику филиала со счёта центра (Фаза Р).
 * Проводок две: реальная у центра и зеркальная у филиала (уезжает ему
 * down-sync'ом). Благодаря зеркалу зарплатный кап филиала видит выплату и не
 * даст выплатить повторно.
 */
export async function payBranchSalary(input: {
  branchId: string
  userId: string
  amount: number
  accountId: string
  period: string
  kind?: 'salary' | 'advance'
  override?: boolean
  overrideReason?: string
  description?: string
}): Promise<void> {
  await unwrap(api.POST('/api/v1/network/payroll/pay', {
    body: {
      branch_id: input.branchId,
      user_id: input.userId,
      amount: String(input.amount),
      account_id: input.accountId,
      period: input.period,
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.override ? { override: true, override_reason: input.overrideReason } : {}),
      ...(input.description ? { description: input.description } : {}),
    } as any,
  }))
}

// ─── Номенклатура сети ─────────────────────────────────────────────────────────
export async function fetchNomenclature(): Promise<Nomenclature[]> {
  const env: any = await unwrap(api.GET('/api/v1/nomenclature'))
  const rows: any[] = Array.isArray(env?.data) ? env.data : []
  return rows.map(r => ({ id: r.id, name: r.name, unit: r.unit, category: r.category }))
}

export async function createNomenclature(input: { name: string; unit?: string; category?: string }): Promise<Nomenclature> {
  const r: any = await unwrap(api.POST('/api/v1/nomenclature', { body: input as any }))
  return { id: r.id, name: r.name, unit: r.unit, category: r.category }
}

/**
 * deleteNomenclature — убрать запись из каталога сети.
 * Товары филиалов, привязанные к ней, ОТВЯЗЫВАЮТСЯ, но не удаляются: у них
 * остаток и история движений. Удаление доезжает до филиалов как tombstone.
 */
export async function deleteNomenclature(id: string): Promise<void> {
  await unwrap(api.DELETE('/api/v1/nomenclature/{id}', { params: { path: { id } } }))
}

export async function linkIngredientNomenclature(ingredientId: string, nomenclatureId: string): Promise<void> {
  await unwrap(api.POST('/api/v1/stock/ingredients/{id}/nomenclature', {
    params: { path: { id: ingredientId } },
    body: { nomenclature_id: nomenclatureId } as any,
  }))
}

// ─── Перемещения ───────────────────────────────────────────────────────────────
export async function fetchTransfers(): Promise<Transfer[]> {
  const env: any = await unwrap(api.GET('/api/v1/stock/transfers'))
  const rows: any[] = Array.isArray(env?.data) ? env.data : []
  return rows.map(mapTransfer)
}

export async function fetchTransfer(id: string): Promise<Transfer> {
  const r: any = await unwrap(api.GET('/api/v1/stock/transfers/{id}', { params: { path: { id } } }))
  return mapTransfer(r)
}

export async function createTransfer(input: {
  toRestaurantId: string
  note?: string
  lines: { ingredientId: string; qty: number; costPerUnit?: number }[]
}): Promise<Transfer> {
  const r: any = await unwrap(api.POST('/api/v1/stock/transfers', {
    body: {
      to_restaurant_id: input.toRestaurantId,
      note: input.note,
      lines: input.lines.map(l => ({
        ingredient_id: l.ingredientId,
        qty: String(l.qty),
        ...(l.costPerUnit != null ? { cost_per_unit: String(l.costPerUnit) } : {}),
      })),
    } as any,
  }))
  return mapTransfer(r)
}

export async function receiveTransfer(id: string): Promise<Transfer> {
  const r: any = await unwrap(api.POST('/api/v1/stock/transfers/{id}/receive', { params: { path: { id } } }))
  return mapTransfer(r)
}

// ─── Переводы денег между узлами сети (ADR-003, Фаза Д) ──────────────────────
// Инкассация филиал→центр и переброска между филиалами. Двухфазный, как
// товарное перемещение: отправитель списывает со своего счёта (sent),
// получатель выбирает СВОЙ счёт и зачисляет (received).

export interface MoneyTransfer {
  id: string
  fromRestaurantId?: string | null
  toRestaurantId?: string | null
  transferNumber?: number | null
  amount: number
  status: 'sent' | 'received' | 'cancelled'
  note?: string | null
  fromAccountId?: string | null
  /** Имя счёта отправителя — денормализовано: у получателя своя БД. */
  fromAccountName?: string | null
  toAccountId?: string | null
  sentAt?: string | null
  receivedAt?: string | null
  createdAt?: string | null
  createdBy?: string | null
  receivedBy?: string | null
}

function mapMoneyTransfer(r: any): MoneyTransfer {
  return {
    id: r.id,
    fromRestaurantId: r.from_restaurant_id,
    toRestaurantId: r.to_restaurant_id,
    transferNumber: r.transfer_number,
    amount: Number(r.amount ?? 0),
    status: r.status,
    note: r.note,
    fromAccountId: r.from_account_id,
    fromAccountName: r.from_account_name,
    toAccountId: r.to_account_id,
    sentAt: r.sent_at,
    receivedAt: r.received_at,
    createdAt: r.created_at,
    createdBy: r.created_by,
    receivedBy: r.received_by,
  }
}

export async function fetchMoneyTransfers(): Promise<MoneyTransfer[]> {
  const env: any = await unwrap(api.GET('/api/v1/money/transfers'))
  const rows: any[] = Array.isArray(env?.data) ? env.data : []
  return rows.map(mapMoneyTransfer)
}

export async function createMoneyTransfer(input: {
  toRestaurantId: string
  fromAccountId: string
  amount: number
  note?: string
}): Promise<MoneyTransfer> {
  const r: any = await unwrap(api.POST('/api/v1/money/transfers', {
    body: {
      to_restaurant_id: input.toRestaurantId,
      from_account_id: input.fromAccountId,
      amount: String(input.amount),
      note: input.note,
    } as any,
  }))
  return mapMoneyTransfer(r)
}

export async function receiveMoneyTransfer(id: string, toAccountId: string): Promise<MoneyTransfer> {
  const r: any = await unwrap(api.POST('/api/v1/money/transfers/{id}/receive', {
    params: { path: { id } },
    body: { to_account_id: toAccountId } as any,
  }))
  return mapMoneyTransfer(r)
}
