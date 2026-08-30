import { api, unwrap } from './_client'
import { logAction } from './audit'

// Central управляет персоналом филиала (097/Фаза 3) — узкая очередь-транспорт:
// central кладёт команду, филиал материализует её своим пулером через свои
// настоящие UsersService.Create/Patch. Учётка появляется в БД филиала не
// сразу, а с задержкой ~30 сек (EmployeeRelayPuller) — ни один из вызовов
// здесь не создаёт/меняет пользователя синхронно, только ставит команду в
// очередь. См. server/internal/service/employee_relay.go.

// Без 'owner'/'superadmin' — тот же набор, что STAFF_ROLES_LIST в
// settings/users/page.tsx: владелец филиала не назначается с центра.
export type EmployeeRelayRole = 'manager' | 'waiter' | 'cashier' | 'cook' | 'storekeeper' | 'accountant' | 'kiosk' | 'other'

export interface EmployeeRelayAction {
  id: string
  targetRestaurantId: string
  targetUserId?: string | null
  kind: string
  status: 'pending' | 'delivered' | 'failed'
  /** Payload команды как есть (форма зависит от kind) — напр. подобранный
   * central'ом PIN для kind=create, если клиент его не передавал. */
  payload?: Record<string, unknown>
}

function mapAction(row: Record<string, unknown> | undefined): EmployeeRelayAction {
  const payload = row?.payload
  return {
    id: (row?.id as string) ?? '',
    targetRestaurantId: (row?.target_restaurant_id as string) ?? '',
    targetUserId: (row?.target_user_id as string | null | undefined) ?? null,
    kind: (row?.kind as string) ?? '',
    status: (row?.status as EmployeeRelayAction['status']) ?? 'pending',
    payload: payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : undefined,
  }
}

export async function requestCreateEmployeeRelay(input: {
  branchId: string
  name: string
  username?: string
  role: EmployeeRelayRole
  phone?: string
  position?: string
  birthDate?: string
  station?: string
  pin?: string
}): Promise<EmployeeRelayAction> {
  const row = await unwrap(api.POST('/api/v1/employee-relay', {
    body: {
      branch_id: input.branchId,
      name: input.name,
      role: input.role,
      username: input.username,
      phone: input.phone,
      position: input.position,
      birth_date: input.birthDate,
      station: input.station,
      pin: input.pin,
    },
  }))
  const action = mapAction(row as Record<string, unknown> | undefined)
  logAction('employee_relay.create', 'user', action.targetUserId ?? undefined, input.name)
  return action
}

export async function requestUpdateEmployeeIdentity(userId: string, input: Partial<{
  name: string
  username: string
  role: EmployeeRelayRole
  position: string
  phone: string
  birthDate: string
  station: string
  pin: string
}>): Promise<EmployeeRelayAction> {
  const row = await unwrap(api.POST('/api/v1/employee-relay/{user_id}/identity', {
    params: { path: { user_id: userId } },
    body: {
      name: input.name,
      username: input.username,
      role: input.role,
      position: input.position,
      phone: input.phone,
      birth_date: input.birthDate,
      station: input.station,
      pin: input.pin,
    },
  }))
  logAction('employee_relay.update_identity', 'user', userId)
  return mapAction(row as Record<string, unknown> | undefined)
}
