package com.restos.kiosk.util

import java.math.BigDecimal
import java.text.NumberFormat
import java.util.Locale

/**
 * Валюта ресторана — сомони/сум, суффикс "с.", НЕ рубль. Зеркалит
 * lib/helpers.ts::formatCurrency (ru-RU, 2 знака, группировка разрядов).
 */
private val somFormat: NumberFormat = NumberFormat.getNumberInstance(Locale("ru", "RU")).apply {
    minimumFractionDigits = 2
    maximumFractionDigits = 2
    isGroupingUsed = true
}

fun formatSom(amount: BigDecimal): String = "${somFormat.format(amount)} с."

fun formatSom(amount: String): String =
    formatSom(runCatching { BigDecimal(amount) }.getOrDefault(BigDecimal.ZERO))
