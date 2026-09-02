// Общие помощники раздела «Учёт времени».
//
// Вынесены из страницы: экранов стало пять, и держать даты, склонения и
// статусы в одном файле с разметкой значило бы править одно и то же место
// из четырёх мест.

import type { RollCallStatus } from '@/lib/queries/schedule'

// ─── Даты ──────────────────────────────────────────────────────────────────
//
// Все даты здесь — календарные строки YYYY-MM-DD и НИКОГДА не Date в ISO:
// график живёт в локальных сутках ресторана, и любой перевод через
// toISOString() сдвигал бы день назад в UTC+5 — та же ловушка, что уже
// стоила ошибок в зарплате (см. isoFromYmd в payroll/page.tsx).

export const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']

export function ymd(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

export function parseYmd(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, (m || 1) - 1, d || 1)
}

/** Понедельник недели, в которую попадает дата. */
export function mondayOf(s: string): string {
  const d = parseYmd(s)
  const shift = (d.getDay() + 6) % 7 // вс=0 → 6
  d.setDate(d.getDate() - shift)
  return ymd(d)
}

export function addDays(s: string, n: number): string {
  const d = parseYmd(s)
  d.setDate(d.getDate() + n)
  return ymd(d)
}

export function shortDate(s: string): string {
  const d = parseYmd(s)
  return `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function isToday(s: string): boolean {
  return s === ymd(new Date())
}

/** «1 смена / 2 смены / 5 смен» — русские окончания, без них счётчик читается как машинный. */
export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return `${n} ${one}`
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} ${few}`
  return `${n} ${many}`
}

/** Время «09:41» из ISO. */
export function timeOf(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

/** «ЩЮ» из имени — аватар-заглушка, чтобы строки различались взглядом. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '—'
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase()
}

export const STATUS_LABEL: Record<RollCallStatus, string> = {
  on_time: 'Вовремя',
  late: 'Опоздал',
  absent: 'Не пришёл',
  unplanned: 'Без графика',
  off: 'Выходной',
}

export const STATUS_TONE: Record<RollCallStatus, string> = {
  on_time: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  late: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  absent: 'bg-red-500/10 text-red-700 dark:text-red-400',
  unplanned: 'bg-sky-500/10 text-sky-700 dark:text-sky-400',
  off: 'bg-muted text-muted-foreground',
}

// Строки-исключения подсвечиваем целиком, а не одним бейджем: смысл экрана —
// с одного взгляда увидеть, где не так, не вчитываясь в каждую строку.
export const ROW_TONE: Record<RollCallStatus, string> = {
  on_time: '',
  late: 'bg-amber-500/[0.06]',
  absent: 'bg-red-500/[0.06]',
  unplanned: 'bg-sky-500/[0.05]',
  off: '',
}

// Цветная полоса слева — тот же сигнал для тех, кто различает не оттенки, а
// форму, и для печати в ч/б.
export const ROW_ACCENT: Record<RollCallStatus, string> = {
  on_time: 'bg-emerald-500/70',
  late: 'bg-amber-500',
  absent: 'bg-red-500',
  unplanned: 'bg-sky-500',
  off: 'bg-transparent',
}

export function EmptyHint({ text }: { text: string }) {
  return (
    <div className="border rounded-xl py-10 text-center text-sm text-muted-foreground bg-card">{text}</div>
  )
}
