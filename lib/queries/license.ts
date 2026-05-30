import { api, unwrap } from './_client'

// License queries — поверх typed openapi client.
//
// Workflow клиента (см. /activate page):
//   1. fetchMachineInfo() → показываем machine_id + restaurant_id на экране
//   2. Клиент копирует, отправляет админу (Telegram/звонок)
//   3. Админ выписывает токен через admin-портал
//   4. activateLicense(token) → backend verify Ed25519 + machine_id check
//   5. fetchLicenseStatus() → видим новый state/expires_at/edition

export interface MachineInfo {
  machineId: string
  restaurantId: string
  restaurantName?: string
}

export interface LicenseStatus {
  state: 'none' | 'active' | 'grace' | 'softLocked' | 'locked'
  expiresAt?: string
  daysLeft: number
  daysUntilLock: number
  isBlocked: boolean
  blockReason?: string
  edition?: string
}

export async function fetchMachineInfo(): Promise<MachineInfo> {
  const r = await unwrap(api.GET('/api/v1/license/machine-id'))
  return {
    machineId: String(r?.machine_id ?? ''),
    restaurantId: String(r?.restaurant_id ?? ''),
    restaurantName: r?.restaurant_name ? String(r.restaurant_name) : undefined,
  }
}

export async function fetchLicenseStatus(): Promise<LicenseStatus> {
  const r: any = await unwrap(api.GET('/api/v1/license/status'))
  return {
    state: (r?.state ?? 'none') as LicenseStatus['state'],
    expiresAt: r?.expires_at ?? undefined,
    daysLeft: Number(r?.days_left ?? 0),
    daysUntilLock: Number(r?.days_until_lock ?? 0),
    isBlocked: Boolean(r?.is_blocked),
    blockReason: r?.block_reason ?? undefined,
    edition: r?.edition ?? undefined,
  }
}

export async function activateLicense(token: string): Promise<LicenseStatus> {
  const r: any = await unwrap(api.POST('/api/v1/license/activate', {
    body: { token },
  }))
  return {
    state: (r?.state ?? 'none') as LicenseStatus['state'],
    expiresAt: r?.expires_at ?? undefined,
    daysLeft: Number(r?.days_left ?? 0),
    daysUntilLock: Number(r?.days_until_lock ?? 0),
    isBlocked: Boolean(r?.is_blocked),
    blockReason: r?.block_reason ?? undefined,
    edition: r?.edition ?? undefined,
  }
}
