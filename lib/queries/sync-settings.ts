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
