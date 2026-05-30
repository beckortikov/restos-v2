package com.restos.waiter.util

import java.math.BigDecimal
import java.math.RoundingMode
import java.text.NumberFormat
import java.util.Locale

/** «1 234 567 сум» — РУБ/СУМ зависит от ресторана, пока хардкодим UZS. */
fun formatCurrency(value: BigDecimal, currency: String = "с."): String {
    val fmt = NumberFormat.getNumberInstance(Locale("ru", "RU")).apply {
        maximumFractionDigits = 2
        minimumFractionDigits = 0
    }
    val rounded = value.setScale(2, RoundingMode.HALF_UP).stripTrailingZeros()
    return "${fmt.format(rounded)} $currency"
}

/** «3 мин», «1 ч 12 мин», «2 ч». Для «X мин назад» на карточке стола. */
fun formatTimeSince(epochMillis: Long, nowMillis: Long = System.currentTimeMillis()): String {
    val seconds = ((nowMillis - epochMillis).coerceAtLeast(0)) / 1000
    val minutes = seconds / 60
    val hours = minutes / 60
    return when {
        minutes < 1 -> "только что"
        hours < 1 -> "$minutes мин"
        hours < 24 -> {
            val m = minutes % 60
            if (m == 0L) "$hours ч" else "$hours ч $m мин"
        }
        else -> {
            val days = hours / 24
            "$days дн"
        }
    }
}
