package com.restos.zakup.util

import java.math.BigDecimal
import java.math.RoundingMode
import java.text.NumberFormat
import java.util.Locale

private val ruGroup = NumberFormat.getNumberInstance(Locale("ru", "RU")).apply {
    maximumFractionDigits = 2
    minimumFractionDigits = 0
}

fun String?.toDecimalOrZero(): BigDecimal =
    this?.trim()?.toBigDecimalOrNull() ?: BigDecimal.ZERO

/** «1 240 000» — сгруппированное число без валюты. */
fun formatAmount(value: BigDecimal): String {
    val rounded = value.setScale(2, RoundingMode.HALF_UP).stripTrailingZeros()
    return ruGroup.format(rounded)
}

/** «1 240 000 с.». */
fun formatMoney(value: BigDecimal, currency: String = "с."): String =
    "${formatAmount(value)} $currency"

/** Крупные суммы компактно: «4.85 млн», «860 тыс», «1 240 000». Для метрик-плиток. */
fun formatCompactMoney(value: BigDecimal): String {
    val abs = value.abs()
    return when {
        abs >= BigDecimal(1_000_000) -> {
            val m = value.divide(BigDecimal(1_000_000), 2, RoundingMode.HALF_UP).stripTrailingZeros()
            "${m.toPlainString()} млн"
        }
        abs >= BigDecimal(100_000) -> {
            val k = value.divide(BigDecimal(1_000), 0, RoundingMode.HALF_UP)
            "${formatAmount(k)} тыс"
        }
        else -> formatAmount(value)
    }
}

/** Инициалы из имени: «Ферма Восход» → «ФВ», «Metro» → «ME». */
fun initialsOf(name: String): String {
    val parts = name.trim().split(" ", "«", "»", "\"").filter { it.isNotBlank() }
    return when {
        parts.isEmpty() -> "—"
        parts.size == 1 -> parts[0].take(2).uppercase()
        else -> (parts[0].take(1) + parts[1].take(1)).uppercase()
    }
}

/** «2.5 кг», «0 л», «24 кг» — количество с единицей. */
fun formatQty(value: BigDecimal, unit: String?): String {
    val n = value.stripTrailingZeros()
    val num = if (n.scale() <= 0) n.toBigInteger().toString() else n.toPlainString()
    return if (unit.isNullOrBlank()) num else "$num $unit"
}
