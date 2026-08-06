import { api, unwrap } from './_client'

export interface SyncSettings {
  enabled: boolean
  centralUrl: string
  token: string
  restaurantId: string
  intervalSec: number
}

export async function fetchSyncSettings(): Promise<SyncSettings> {
  const r: any = await unwrap(api.GET('/api/v1/settings/sync'))
  return {
    enabled: !!r?.enabled,
    centralUrl: r?.central_url ?? '',
    token: r?.token ?? '',
    restaurantId: r?.restaurant_id ?? '',
    intervalSec: Number(r?.interval_sec ?? 30),
  }
}

export async function saveSyncSettings(s: SyncSettings): Promise<void> {
  await unwrap(api.PUT('/api/v1/settings/sync', {
    body: {
      enabled: s.enabled,
      central_url: s.centralUrl,
      token: s.token,
      restaurant_id: s.restaurantId,
      interval_sec: s.intervalSec,
    } as any,
  }))
}

// joinNetwork — обменивает код приглашения (ADR-003, продолжение) на central
// на настоящий sync-токен+account_id и сохраняет всё атомарно на бэке;
// UI после успеха просто перечитывает fetchSyncSettings().
export async function joinNetwork(pairingCode: string): Promise<{ centralName: string }> {
  const r: any = await unwrap(api.POST('/api/v1/network/pair', { body: { pairing_code: pairingCode } as any }))
  return { centralName: r?.central_name ?? '' }
}
