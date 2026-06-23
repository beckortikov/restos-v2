package com.restos.waiter.ui.composer

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.restos.waiter.data.menu.MenuItemDto
import com.restos.waiter.util.formatCurrency
import java.math.BigDecimal
import java.math.RoundingMode

/**
 * Диалог ввода веса для весового блюда (unit "g" / "kg").
 * Шаг — saleStep (или 10 г / 0.1 кг по умолчанию), пресеты быстрого выбора,
 * вживую считает цену: price * (вес / unitSize).
 *
 * @param initialGrams предзаполнение (текущий вес в корзине), либо null.
 */
@Composable
fun WeightDialog(
    item: MenuItemDto,
    initialGrams: String?,
    initialPortions: Int = 1,
    onDismiss: () -> Unit,
    onConfirm: (grams: BigDecimal, portions: Int) -> Unit,
) {
    val isKg = item.unit == "kg"
    val unitLabel = if (isKg) "кг" else "г"
    val price = runCatching { BigDecimal(item.price) }.getOrDefault(BigDecimal.ZERO)
    val unitSize = runCatching { BigDecimal(item.unitSize) }.getOrDefault(BigDecimal.ONE)
        .let { if (it <= BigDecimal.ZERO) BigDecimal.ONE else it }
    val step = runCatching { BigDecimal(item.saleStep) }.getOrNull()
        ?.takeIf { it > BigDecimal.ZERO }
        ?: if (isKg) BigDecimal("0.05") else BigDecimal("50")
    val presets: List<BigDecimal> =
        if (isKg) listOf("0.1", "0.15", "0.2", "0.25", "0.3").map { BigDecimal(it) }
        else listOf("100", "150", "200", "250", "300").map { BigDecimal(it) }

    fun fmt(v: BigDecimal): String = v.stripTrailingZeros().toPlainString()

    // Дефолт веса одной порции: 0.1 кг = 100 г (как в вебе ПОС).
    val start = runCatching { BigDecimal(initialGrams) }.getOrNull()
        ?.takeIf { it > BigDecimal.ZERO }
        ?: if (isKg) BigDecimal("0.1") else BigDecimal("100")
    // text — редактируемый источник правды; −/+ и пресеты пишут в него.
    var text by remember { mutableStateOf(fmt(start)) }
    var portions by remember { mutableStateOf(initialPortions.coerceAtLeast(1)) }
    val value = parseWeight(text)
    val onePortion = price.multiply(value.divide(unitSize, 4, RoundingMode.HALF_EVEN))
    val lineTotal = onePortion.multiply(portions.toBigDecimal())

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(item.name, fontWeight = FontWeight.SemiBold) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                // − [ редактируемый вес ] +
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    StepBtn("−", modifier = Modifier.size(56.dp)) {
                        text = fmt((value - step).coerceAtLeast(BigDecimal.ZERO))
                    }
                    OutlinedTextField(
                        value = text,
                        onValueChange = { raw ->
                            // Пускаем только цифры и один разделитель (.,).
                            val cleaned = raw.replace(',', '.').filter { it.isDigit() || it == '.' }
                            val oneDot = cleaned.indexOf('.').let { i ->
                                if (i < 0) cleaned else cleaned.substring(0, i + 1) +
                                    cleaned.substring(i + 1).replace(".", "")
                            }
                            text = oneDot
                        },
                        suffix = { Text(unitLabel) },
                        singleLine = true,
                        textStyle = TextStyle(
                            fontSize = 28.sp,
                            fontWeight = FontWeight.Bold,
                            textAlign = TextAlign.Center,
                        ),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                        modifier = Modifier.width(150.dp),
                    )
                    StepBtn("+", modifier = Modifier.size(56.dp)) {
                        text = fmt(value + step)
                    }
                }
                // Цена за выбранный вес.
                Text(
                    formatCurrency(lineTotal),
                    fontSize = 16.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.fillMaxWidth(),
                    textAlign = TextAlign.Center,
                )
                // Пресеты
                LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(presets) { p ->
                        Surface(
                            shape = RoundedCornerShape(50),
                            color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
                            onClick = { text = fmt(p) },
                        ) {
                            Text(
                                "${fmt(p)} $unitLabel",
                                fontSize = 13.sp,
                                fontWeight = FontWeight.Medium,
                                modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
                            )
                        }
                    }
                }
                // Кол-во порций: «N по {вес}». На чеке/кухне печатается N строками.
                Text(
                    "Кол-во порций" + if (portions > 1) " · ${portions} × ${fmt(value)} $unitLabel" else "",
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Medium,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
                )
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    StepBtn("−", modifier = Modifier.size(56.dp)) {
                        portions = (portions - 1).coerceAtLeast(1)
                    }
                    Text(
                        portions.toString(),
                        fontSize = 28.sp,
                        fontWeight = FontWeight.Bold,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.width(150.dp),
                    )
                    StepBtn("+", modifier = Modifier.size(56.dp)) {
                        portions += 1
                    }
                }
            }
        },
        confirmButton = {
            Surface(
                modifier = Modifier.height(48.dp),
                shape = RoundedCornerShape(10.dp),
                color = MaterialTheme.colorScheme.primary,
                onClick = { onConfirm(value, portions) },
            ) {
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier.padding(horizontal = 20.dp).height(48.dp),
                ) {
                    Text(
                        "Добавить",
                        fontSize = 16.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = MaterialTheme.colorScheme.onPrimary,
                    )
                }
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Отмена") }
        },
    )
}

/** Парсинг введённого веса: пустое/«.»/мусор → 0. */
private fun parseWeight(text: String): BigDecimal =
    runCatching { BigDecimal(text) }.getOrDefault(BigDecimal.ZERO)

@Composable
private fun StepBtn(label: String, modifier: Modifier, onClick: () -> Unit) {
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(12.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f),
        onClick = onClick,
    ) {
        Box(contentAlignment = Alignment.Center) {
            Text(label, fontSize = 26.sp, fontWeight = FontWeight.Bold)
        }
    }
}
