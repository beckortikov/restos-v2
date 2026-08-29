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

// SyncQueueStats — состояние очереди отправки на central (ADR-003, Фаза О).
// Единственный способ для оператора убедиться, что накопленное за время без
// интернета действительно уехало.
export interface SyncQueueStats {
  pending: number
  failed: number
  oldestPendingAt?: string | null
  lastSyncedAt?: string | null
  lastError?: string | null
}

export async function fetchSyncQueueStats(): Promise<SyncQueueStats> {
  const r: any = await unwrap(api.GET('/api/v1/settings/sync/queue'))
  return {
    pending: Number(r?.pending ?? 0),
    failed: Number(r?.failed ?? 0),
    oldestPendingAt: r?.oldest_pending_at ?? null,
    lastSyncedAt: r?.last_synced_at ?? null,
    lastError: r?.last_error ?? null,
  }
}

// backfillSync — «Отправить историю на central» (ADR-003 Ф6): ставит в
// очередь ТЕКУЩЕЕ состояние каждой реплицируемой таблицы этого филиала,
// обычный пушер доставит на следующих циклах. Нужна для данных, заведённых
// ДО включения синхронизации (или мимо неё — напр. массовый импорт
// сотрудников, найдено 2026-08-29: central не видел официанта с 88 заказами,
// пока не отправили историю вручную). Идемпотентна, owner-only на бэке.
export interface SyncBackfillResult {
  entities: Record<string, number>
}

export async function backfillSync(): Promise<SyncBackfillResult> {
  const r: any = await unwrap(api.POST('/api/v1/sync/backfill', {}))
  return { entities: r?.entities ?? {} }
}

// joinNetwork — обменивает код приглашения (ADR-003, продолжение) на central
// на настоящий sync-токен+account_id и сохраняет всё атомарно на бэке;
// UI после успеха просто перечитывает fetchSyncSettings().
export async function joinNetwork(pairingCode: string): Promise<{ centralName: string }> {
  const r: any = await unwrap(api.POST('/api/v1/network/pair', { body: { pairing_code: pairingCode } as any }))
  return { centralName: r?.central_name ?? '' }
}
