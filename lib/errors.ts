// lib/errors.ts — превращение технических ошибок в человеческие сообщения.
//
// Проблема которую решаем: раньше в toast'ах показывали сырой текст —
// `e.message` мог содержать «pg_dump failed: exec: ...», «SQLSTATE 23505»,
// JSON-енвелоп бэка и т.п. Кассир/официант такое читать не должен.
//
// humanizeError(e) маппит:
//   - известные коды ErrorEnvelope бэка (V4Error.envelope().code)
//   - известные технические подстроки (Postgres коды, pg_dump, fetch)
// в понятный русский текст. Неизвестное — общий безопасный фолбэк.

import { V4Error } from '@/lib/api'

// Коды ErrorEnvelope из Go-бэка (internal/pkg/errors) → русский текст.
const CODE_MESSAGES: Record<string, string> = {
  VALIDATION: 'Проверьте введённые данные — что-то заполнено неверно.',
  NOT_FOUND: 'Запись не найдена. Возможно, её уже удалили.',
  CONFLICT: 'Действие конфликтует с текущим состоянием. Обновите страницу и попробуйте снова.',
  UNAUTHORIZED: 'Сессия истекла. Войдите заново.',
  FORBIDDEN: 'Недостаточно прав для этого действия.',
  LICENSE_LOCKED: 'Лицензия заблокирована — продлите её, чтобы продолжить работу.',
  ROLE_NOT_AVAILABLE_LOCALLY: 'Эта роль недоступна на кассе.',
  IDEMPOTENCY_CONFLICT: 'Повторный запрос с другими данными. Обновите страницу.',
  INTERNAL: 'Внутренняя ошибка сервера. Попробуйте ещё раз.',
  MAINTENANCE: 'Идёт восстановление базы из резервной копии, подождите…',
}

// Технические подстроки в тексте ошибки → человеческое сообщение.
// Срабатывают когда у ошибки нет известного кода, но текст узнаваем.
const PATTERN_MESSAGES: Array<{ test: RegExp; msg: string }> = [
  { test: /pg_restore failed/i, msg: 'Не удалось восстановить базу из резервной копии. Файл повреждён или несовместим — проверьте, что это .dump этой кассы.' },
  { test: /pg_restore|pg_dump/i, msg: 'Не удалось создать резервную копию. Проверьте, что установлен PostgreSQL.' },
  { test: /insufficient funds/i, msg: 'Недостаточно средств на счёте.' },
  { test: /failed to fetch|network|econnrefused|fetch failed/i, msg: 'Нет связи с сервером кассы. Проверьте, что касса запущена и вы в той же сети.' },
  { test: /timeout|deadline exceeded/i, msg: 'Сервер не ответил вовремя. Попробуйте ещё раз.' },
  { test: /23505|duplicate key|unique constraint/i, msg: 'Такая запись уже существует.' },
  { test: /23503|foreign key/i, msg: 'Нельзя удалить — на эту запись ссылаются другие данные.' },
  { test: /shift|смену/i, msg: 'Откройте кассовую смену, чтобы продолжить.' },
]

/**
 * humanizeError — безопасное русское сообщение из любой ошибки.
 *
 * @param e — пойманная ошибка (V4Error, Error, строка, что угодно)
 * @param fallback — что показать если ничего не распознали (по умолчанию общий текст)
 */
export function humanizeError(e: unknown, fallback = 'Что-то пошло не так. Попробуйте ещё раз.'): string {
  // 1. V4Error с кодом ErrorEnvelope — самый надёжный сигнал.
  if (e instanceof V4Error) {
    const env = e.envelope()
    if (env?.code && CODE_MESSAGES[env.code]) return CODE_MESSAGES[env.code]
    // Код неизвестен, но message бэка может быть уже человеческим (валидация).
    if (env?.message && isHumanReadable(env.message)) return env.message
    if (e.status === 0) return PATTERN_MESSAGES[2].msg // network
  }

  // 2. Текст ошибки → паттерны.
  const text = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
  for (const p of PATTERN_MESSAGES) {
    if (p.test.test(text)) return p.msg
  }

  // 3. Если текст уже выглядит человеческим (русский, короткий, без тех-мусора) —
  // показываем как есть. Иначе — фолбэк.
  if (text && isHumanReadable(text)) return text
  return fallback
}

// isHumanReadable — эвристика «это сообщение можно показать юзеру».
// Отсекаем сырой тех-мусор: JSON, стек-трейсы, SQLSTATE, длинные строки без пробелов.
function isHumanReadable(s: string): boolean {
  if (!s || s.length > 160) return false
  if (/^[{[]/.test(s.trim())) return false // JSON
  if (/SQLSTATE|exec:|panic:|goroutine|0x[0-9a-f]{6}|\bat\s+\w+\.\w+/.test(s)) return false
  // Должны быть пробелы (это фраза, а не идентификатор/код).
  if (!/\s/.test(s)) return false
  return true
}
