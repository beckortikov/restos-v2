package com.restos.checkin.util

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

private val hhmm = DateTimeFormatter.ofPattern("HH:mm", Locale("ru"))
private val dayMonth = DateTimeFormatter.ofPattern("d MMMM, EEEE", Locale("ru"))

/** «09:03» из RFC3339, который отдаёт Go-бэк (UTC → часовой пояс планшета). */
fun formatClock(iso: String?): String {
    if (iso.isNullOrBlank()) return "—"
    return runCatching {
        Instant.parse(iso).atZone(ZoneId.systemDefault()).format(hhmm)
    }.getOrDefault("—")
}

fun formatClock(instant: Instant): String =
    instant.atZone(ZoneId.systemDefault()).format(hhmm)

fun formatToday(instant: Instant): String =
    instant.atZone(ZoneId.systemDefault()).format(dayMonth)

/**
 * «5 ч 12 мин» — длительность смены словами. Минуты без часов («47 мин»)
 * читаются с расстояния лучше, чем «0 ч 47 мин».
 */
fun formatDuration(minutes: Int): String {
    if (minutes <= 0) return "меньше минуты"
    val h = minutes / 60
    val m = minutes % 60
    return when {
        h == 0 -> "$m мин"
        m == 0 -> "$h ч"
        else -> "$h ч $m мин"
    }
}
