import { api, unwrap } from './_client'
import { getBaseURL } from '../api'
import { logAction } from './audit'

// Плановый график смен (102) и перекличка «план против факта».
//
// Время смены — строка 'HH:MM' локального времени ресторана, не Date: график
// составляется в человеческих часах и не привязан к дате. Сравнение с фактом
// делает бэк через restaurants.timezone — на клиенте часы не пересчитываем,
// иначе получили бы ровно тот TZ-сдвиг, что уже ловили в зарплате.

export interface ScheduleTemplateSlot {
  id: string
  userId: string
  /** ISO: 1 = понедельник … 7 = воскресенье. */
  weekday: number
  startsAt: string
  endsAt: string
}

export interface PlannedShift {
  date: string
  userId: string
  userName: string
  startsAt: string
  endsAt: string
  /** template — из недельного шаблона, override — правка на эту дату. */
  source: 'template' | 'override'
  isOff: boolean
  note?: string
}

export type RollCallStatus = 'on_time' | 'late' | 'absent' | 'unplanned' | 'off'

export interface RollCallRow {
  userId: string
  userName: string
  status: RollCallStatus
  plannedStart?: string
  plannedEnd?: string
  clockIn?: string
  clockOut?: string
  lateMinutes: number
  source?: 'template' | 'override'
  /** Отметка табеля — по ней тянется оригинал снимка. */
  entryId?: string
  /** Превью селфи прихода, base64 JPEG (103). Оригинал — fetchAttendancePhoto. */
  photoThumb?: string
}

export interface RollCallReport {
  date: string
  timezone: string
  planned: number
  present: number
  late: number
  absent: number
  unplanned: number
  rows: RollCallRow[]
}

function mapSlot(row: any): ScheduleTemplateSlot {
  return {
    id: String(row?.id ?? ''),
    userId: String(row?.user_id ?? ''),
    weekday: Number(row?.weekday ?? 0),
    startsAt: String(row?.starts_at ?? ''),
    endsAt: String(row?.ends_at ?? ''),
  }
}

function mapPlanned(row: any): PlannedShift {
  return {
    date: String(row?.date ?? '').slice(0, 10),
    userId: String(row?.user_id ?? ''),
    userName: String(row?.user_name ?? ''),
    startsAt: String(row?.starts_at ?? ''),
    endsAt: String(row?.ends_at ?? ''),
    source: row?.source === 'override' ? 'override' : 'template',
    isOff: row?.is_off === true,
    note: row?.note ? String(row.note) : undefined,
  }
}

export async function fetchSchedule(from: string, to: string, userId?: string): Promise<PlannedShift[]> {
  const query: Record<string, string> = { from, to }
  if (userId) query.user_id = userId
  const res: any = await unwrap(api.GET('/api/v1/schedule', { params: { query } as any }))
  const rows: any[] = Array.isArray(res?.data) ? res.data : []
  return rows.map(mapPlanned)
}

export async function fetchScheduleTemplate(userId: string): Promise<ScheduleTemplateSlot[]> {
  const res: any = await unwrap(api.GET('/api/v1/schedule/template', { params: { query: { user_id: userId } } as any }))
  const rows: any[] = Array.isArray(res?.data) ? res.data : []
  return rows.map(mapSlot)
}

/** PUT-семантика: шаблон заменяется целиком, снятые дни исчезают. */
export async function saveScheduleTemplate(
  userId: string,
  slots: Array<{ weekday: number; startsAt: string; endsAt: string }>,
): Promise<ScheduleTemplateSlot[]> {
  const res: any = await unwrap(api.PUT('/api/v1/schedule/template', {
    body: {
      user_id: userId,
      slots: slots.map((s) => ({ weekday: s.weekday, starts_at: s.startsAt, ends_at: s.endsAt })),
    } as any,
  }))
  logAction('schedule.template_set', 'user', userId, 'Изменил недельный график', { days: slots.length })
  const rows: any[] = Array.isArray(res?.data) ? res.data : []
  return rows.map(mapSlot)
}

export async function setScheduleDay(input: {
  userId: string
  date: string
  kind: 'work' | 'off'
  startsAt?: string
  endsAt?: string
  note?: string
}): Promise<void> {
  await unwrap(api.PUT('/api/v1/schedule/day', {
    body: {
      user_id: input.userId,
      date: input.date,
      kind: input.kind,
      starts_at: input.startsAt,
      ends_at: input.endsAt,
      note: input.note,
    } as any,
  }))
  logAction(
    'schedule.day_set', 'user', input.userId,
    input.kind === 'off' ? `Отгул ${input.date}` : `Смена ${input.date} ${input.startsAt}–${input.endsAt}`,
  )
}

/** Снять правку на дату — день вернётся к недельному шаблону. */
export async function deleteScheduleDay(userId: string, date: string): Promise<void> {
  await unwrap(api.DELETE('/api/v1/schedule/day', { params: { query: { user_id: userId, date } } as any }))
  logAction('schedule.day_reset', 'user', userId, `Вернул ${date} к шаблону`)
}

export async function fetchRollCall(date: string): Promise<RollCallReport> {
  const res: any = await unwrap(api.GET('/api/v1/schedule/roll-call', { params: { query: { date } } as any }))
  const rows: any[] = Array.isArray(res?.rows) ? res.rows : []
  return {
    date: String(res?.date ?? date).slice(0, 10),
    timezone: String(res?.timezone ?? ''),
    planned: Number(res?.planned ?? 0),
    present: Number(res?.present ?? 0),
    late: Number(res?.late ?? 0),
    absent: Number(res?.absent ?? 0),
    unplanned: Number(res?.unplanned ?? 0),
    rows: rows.map((r: any) => ({
      userId: String(r?.user_id ?? ''),
      userName: String(r?.user_name ?? ''),
      status: (r?.status ?? 'absent') as RollCallStatus,
      plannedStart: r?.planned_start || undefined,
      plannedEnd: r?.planned_end || undefined,
      clockIn: r?.clock_in || undefined,
      clockOut: r?.clock_out || undefined,
      lateMinutes: Number(r?.late_minutes ?? 0),
      source: r?.source || undefined,
      entryId: r?.entry_id || undefined,
      photoThumb: r?.photo_thumb || undefined,
    })),
  }
}

/**
 * Оригинал селфи отметки как object URL для <img>.
 *
 * Не через openapi-клиент: тот разбирает ответ как JSON, а здесь бинарный
 * JPEG. И не прямой ссылкой в src — эндпоинт под Bearer-токеном, который
 * тег <img> не отправит.
 *
 * Вызывающий обязан отозвать URL через URL.revokeObjectURL, иначе снимки
 * копятся в памяти вкладки.
 */
export async function fetchAttendancePhoto(entryId: string, kind: 'in' | 'out' = 'in'): Promise<string> {
  const token = localStorage.getItem('restos-v4-token') || ''
  const res = await fetch(
    `${getBaseURL()}api/v1/attendance/photo/${encodeURIComponent(entryId)}?kind=${kind}`,
    { headers: token ? { Authorization: `Bearer ${token}` } : {} },
  )
  if (!res.ok) throw new Error(res.status === 404 ? 'Снимок не сохранён или уже удалён' : `HTTP ${res.status}`)
  return URL.createObjectURL(await res.blob())
}
