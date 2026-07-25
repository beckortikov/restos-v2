package com.restos.zakup.ui.receipts

import com.restos.zakup.data.receipts.StockReceiptDto
import com.restos.zakup.ui.components.BadgeKind
import com.restos.zakup.util.toDecimalOrZero
import java.math.BigDecimal
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter

enum class ReceiptStatus(val label: String, val kind: BadgeKind) {
    Paid("Оплачено", BadgeKind.Success),
    Debt("Долг", BadgeKind.Danger),
    Overdue("Просрочен", BadgeKind.Danger),
}

data class ReceiptRow(
    val id: String,
    val supplierName: String,
    val dateLabel: String,
    val dayKey: String,      // YYYY-MM-DD для группировки в истории
    val amount: BigDecimal,          // «по факту» — сумма счёта минус возвраты
    val grossAmount: BigDecimal,     // исходная сумма счёта (для зачёркивания)
    val returnedTotal: BigDecimal,   // сумма действующих возвратов
    val status: ReceiptStatus,
    val lineCount: Int?,
) {
    val hasReturn: Boolean get() = returnedTotal.signum() > 0
}

private val months = listOf(
    "января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря",
)

/** «Сегодня, 09:14» / «Вчера, 17:40» / «20 июля». */
private fun dateLabelOf(dateStr: String?, createdAt: String?): Pair<String, String> {
    val dt = parseInstant(createdAt)
    val day = dt?.toLocalDate() ?: parseDate(dateStr) ?: LocalDate.now()
    val today = LocalDate.now()
    val time = dt?.toLocalTime()?.format(DateTimeFormatter.ofPattern("HH:mm"))
    val label = when (day) {
        today -> "Сегодня" + (time?.let { ", $it" } ?: "")
        today.minusDays(1) -> "Вчера" + (time?.let { ", $it" } ?: "")
        else -> "${day.dayOfMonth} ${months[day.monthValue - 1]}"
    }
    return label to day.toString()
}

private fun parseInstant(s: String?): OffsetDateTime? =
    s?.let { runCatching { OffsetDateTime.parse(it) }.getOrNull() }

private fun parseDate(s: String?): LocalDate? =
    s?.take(10)?.let { runCatching { LocalDate.parse(it) }.getOrNull() }

fun StockReceiptDto.toReceiptRow(): ReceiptRow {
    val debt = debtAmount.toDecimalOrZero()
    val overdue = debt.signum() > 0 && parseDate(dueDate)?.isBefore(LocalDate.now()) == true
    val status = when {
        debt.signum() <= 0 -> ReceiptStatus.Paid
        overdue -> ReceiptStatus.Overdue
        else -> ReceiptStatus.Debt
    }
    val (label, key) = dateLabelOf(date, createdAt)
    val gross = totalAmount.toDecimalOrZero()
    val returned = returnedTotal.toDecimalOrZero()
    // «По факту» = счёт минус возвраты. Оборот поставщика и суммы в списках
    // считаются по этому нетто, иначе возврат не уменьшает у поставщика.
    val net = (gross - returned).coerceAtLeast(BigDecimal.ZERO)
    return ReceiptRow(
        id = id,
        supplierName = supplierName?.takeIf { it.isNotBlank() } ?: "Без поставщика",
        dateLabel = label,
        dayKey = key,
        amount = net,
        grossAmount = gross,
        returnedTotal = returned,
        status = status,
        lineCount = lines?.size,
    )
}
