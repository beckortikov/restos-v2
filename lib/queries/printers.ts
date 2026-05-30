import { api, unwrap } from './_client'

const VIRTUAL_NAME_PREFIX = '[virtual]'

type DBPrinter = {
  id: string
  name: string
  kind: string
  driver: string
  enabled: boolean
  is_default: boolean
  target: string
}

export async function listPrinters(): Promise<DBPrinter[]> {
  const res: any = await unwrap(api.GET('/api/v1/printers'))
  return res?.data ?? []
}

export async function createPrinter(input: {
  name: string
  kind: 'receipt' | 'station'
  driver: 'virtual' | 'tcp' | 'usb' | 'mock'
  target: string
  is_default?: boolean
  enabled?: boolean
  station?: string
}): Promise<DBPrinter> {
  const res: any = await unwrap(api.POST('/api/v1/printers', { body: input as any }))
  return res
}

export async function updatePrinter(
  id: string,
  input: Partial<{ enabled: boolean; is_default: boolean; target: string }>,
): Promise<DBPrinter> {
  const res: any = await unwrap(
    api.PATCH('/api/v1/printers/{id}', { params: { path: { id } }, body: input as any }),
  )
  return res
}

export async function deletePrinter(id: string): Promise<void> {
  await unwrap(api.DELETE('/api/v1/printers/{id}', { params: { path: { id } } }))
}

// ensureBackendVirtualPrinters создаёт или включает два виртуальных принтера
// в БД (receipt + station), чтобы вся бэкендовая печать (auto-runner на
// создании заказа, cancel-runner, close_order receipt, pre-bill) шла в
// virtual fallback вместо реального TCP/USB.
//
// Идемпотентно: если row с name=VIRTUAL_RECEIPT уже существует — просто
// enabled=true, иначе создаёт.
export async function ensureBackendVirtualPrinters(): Promise<void> {
  const existing = await listPrinters()
  const receipt = existing.find(
    p => p.name === `${VIRTUAL_NAME_PREFIX} receipt` && p.driver === 'virtual',
  )
  const station = existing.find(
    p => p.name === `${VIRTUAL_NAME_PREFIX} station` && p.driver === 'virtual',
  )
  if (receipt) {
    await updatePrinter(receipt.id, { enabled: true, is_default: true })
  } else {
    await createPrinter({
      name: `${VIRTUAL_NAME_PREFIX} receipt`,
      kind: 'receipt',
      driver: 'virtual',
      target: '',
      is_default: true,
      enabled: true,
    })
  }
  if (station) {
    await updatePrinter(station.id, { enabled: true })
  } else {
    await createPrinter({
      name: `${VIRTUAL_NAME_PREFIX} station`,
      kind: 'station',
      driver: 'virtual',
      target: '',
      is_default: false,
      enabled: true,
    })
  }
}

// disableBackendVirtualPrinters отключает (enabled=false) оба виртуальных
// row'а если они есть. Удалять не будем — чтобы при повторном включении
// сохранилась настройка target/name.
export async function disableBackendVirtualPrinters(): Promise<void> {
  const existing = await listPrinters()
  for (const p of existing) {
    if (p.driver === 'virtual' && p.name.startsWith(VIRTUAL_NAME_PREFIX) && p.enabled) {
      await updatePrinter(p.id, { enabled: false })
    }
  }
}
