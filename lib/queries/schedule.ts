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
  /** Сколько система предлагает удержать за это опоздание (105). */
  suggestedFine?: string
  /** За этот день штраф уже выставлен. */
  fined: boolean
  /** Отметка табеля — по ней тянется оригинал снимка. */
  entryId?: string
  /** Превью селфи прихода, base64 JPEG (103). Оригинал — fetchAttendancePhoto. */
  photoThumb?: string
}

export interface RollCallReport {
  date: string
  timezone: string
  /** Сколько минут опоздания не считаются опозданием (105). */
  graceMinutes: number
  /** Заданы ли правила штрафов; если нет — суммы не предлагаются. */
  finesConfigured: boolean
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

export interface TimeReport {
  from: string
  to: string
  totalHours: number
  prevTotalHours: number
  shifts: number
  avgShiftHours: number
  plannedCount: number
  onTimeCount: number
  lateCount: number
  absentCount: number
  punctuality: number
  /** 7 значений, начиная с понедельника. */
  hoursByWeekday: number[]
  payrollAccrued: number
  top: Array<{ userId: string; userName: string; position?: string; hours: number }>
}

export async function fetchTimeReport(from: string, to: string): Promise<TimeReport> {
  const r: any = await unwrap(api.GET('/api/v1/schedule/report', { params: { query: { from, to } } as any }))
  const wd: number[] = Array.isArray(r?.hours_by_weekday) ? r.hours_by_weekday.map(Number) : []
  return {
    from: String(r?.from ?? from),
    to: String(r?.to ?? to),
    totalHours: Number(r?.total_hours ?? 0),
    prevTotalHours: Number(r?.prev_total_hours ?? 0),
    shifts: Number(r?.shifts ?? 0),
    avgShiftHours: Number(r?.avg_shift_hours ?? 0),
    plannedCount: Number(r?.planned_count ?? 0),
    onTimeCount: Number(r?.on_time_count ?? 0),
    lateCount: Number(r?.late_count ?? 0),
    absentCount: Number(r?.absent_count ?? 0),
    punctuality: Number(r?.punctuality ?? 0),
    hoursByWeekday: wd.length === 7 ? wd : new Array(7).fill(0),
    payrollAccrued: Number(r?.payroll_accrued ?? 0),
    top: (Array.isArray(r?.top) ? r.top : []).map((t: any) => ({
      userId: String(t?.user_id ?? ''),
      userName: String(t?.user_name ?? ''),
      position: t?.position || undefined,
      hours: Number(t?.hours ?? 0),
    })),
  }
}

export type JournalKind = 'in' | 'out'

export interface JournalEvent {
  entryId: string
  userId: string
  userName: string
  kind: JournalKind
  at: string
  /** Откуда отметка: app — терминал, manual — руками в табеле. */
  source?: string
  photoThumb?: string
  lateMinutes: number
}

/**
 * Лента отметок за день. Именно события, а не смены: у прихода и ухода своё
 * время и свой снимок, и разворачивает их сервер — иначе каждый экран
 * разворачивал бы по-своему.
 */
export async function fetchJournal(date: string): Promise<JournalEvent[]> {
  const res: any = await unwrap(api.GET('/api/v1/schedule/journal', { params: { query: { date } } as any }))
  const rows: any[] = Array.isArray(res?.data) ? res.data : []
  return rows.map((r: any) => ({
    entryId: String(r?.entry_id ?? ''),
    userId: String(r?.user_id ?? ''),
    userName: String(r?.user_name ?? ''),
    kind: r?.kind === 'out' ? 'out' : 'in',
    at: String(r?.at ?? ''),
    source: r?.source || undefined,
    photoThumb: r?.photo_thumb || undefined,
    lateMinutes: Number(r?.late_minutes ?? 0),
  }))
}

export async function fetchRollCall(date: string): Promise<RollCallReport> {
  const res: any = await unwrap(api.GET('/api/v1/schedule/roll-call', { params: { query: { date } } as any }))
  const rows: any[] = Array.isArray(res?.rows) ? res.rows : []
  return {
    date: String(res?.date ?? date).slice(0, 10),
    timezone: String(res?.timezone ?? ''),
    graceMinutes: Number(res?.grace_minutes ?? 0),
    finesConfigured: res?.fines_configured === true,
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
      suggestedFine: r?.suggested_fine || undefined,
      fined: r?.fined === true,
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
  // getBaseURL отдаёт origin БЕЗ завершающего слэша (а в same-origin режиме —
  // пустую строку), поэтому склеиваем через явный разделитель: без него
  // получалось «http://host:3002api/v1/…» и fetch падал на разборе URL.
  const base = getBaseURL().replace(/\/$/, '')
  const res = await fetch(
    `${base}/api/v1/attendance/photo/${encodeURIComponent(entryId)}?kind=${kind}`,
    { headers: token ? { Authorization: `Bearer ${token}` } : {} },
  )
  if (!res.ok) throw new Error(res.status === 404 ? 'Снимок не сохранён или уже удалён' : `HTTP ${res.status}`)
  return URL.createObjectURL(await res.blob())
}

/**
 * Удержать штраф за опоздание. Сумму считает сервер по политике ресторана —
 * клиент передаёт только «кого» и «за какой день», иначе в удержание можно
 * было бы отправить любое число мимо правил.
 */
export async function fineLate(userId: string, date: string): Promise<void> {
  await unwrap(api.POST('/api/v1/schedule/roll-call/fine', {
    body: { user_id: userId, date } as any,
  }))
  logAction('schedule.late_fine', 'user', userId, `Штраф за опоздание ${date}`)
}
