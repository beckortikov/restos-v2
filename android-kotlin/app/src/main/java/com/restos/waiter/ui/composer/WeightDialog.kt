package com.restos.waiter.ui.composer

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.text.font.FontWeight
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
    onDismiss: () -> Unit,
    onConfirm: (BigDecimal) -> Unit,
) {
    val isKg = item.unit == "kg"
    val unitLabel = if (isKg) "кг" else "г"
    val price = runCatching { BigDecimal(item.price) }.getOrDefault(BigDecimal.ZERO)
    val unitSize = runCatching { BigDecimal(item.unitSize) }.getOrDefault(BigDecimal.ONE)
        .let { if (it <= BigDecimal.ZERO) BigDecimal.ONE else it }
    val step = runCatching { BigDecimal(item.saleStep) }.getOrNull()
        ?.takeIf { it > BigDecimal.ZERO }
        ?: if (isKg) BigDecimal("0.1") else BigDecimal("10")
    val presets: List<BigDecimal> =
        if (isKg) listOf("0.2", "0.5", "1", "1.5", "2").map { BigDecimal(it) }
        else listOf("100", "200", "300", "500", "1000").map { BigDecimal(it) }

    val start = runCatching { BigDecimal(initialGrams) }.getOrNull()
        ?.takeIf { it > BigDecimal.ZERO }
        ?: if (isKg) BigDecimal("0.5") else BigDecimal("100")
    var value by remember { mutableStateOf(start) }

    fun fmt(v: BigDecimal): String = v.stripTrailingZeros().toPlainString()
    val lineTotal = price.multiply(value.divide(unitSize, 4, RoundingMode.HALF_EVEN))

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(item.name, fontWeight = FontWeight.SemiBold) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                // − [ вес ] +
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    StepBtn("−", modifier = Modifier.size(56.dp)) {
                        value = (value - step).coerceAtLeast(BigDecimal.ZERO)
                    }
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("${fmt(value)} $unitLabel", fontSize = 30.sp, fontWeight = FontWeight.Bold)
                        Text(
                            formatCurrency(lineTotal),
                            fontSize = 15.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = MaterialTheme.colorScheme.primary,
                        )
                    }
                    StepBtn("+", modifier = Modifier.size(56.dp)) { value += step }
                }
                // Пресеты
                LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(presets) { p ->
                        Surface(
                            shape = RoundedCornerShape(50),
                            color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
                            onClick = { value = p },
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
            }
        },
        confirmButton = {
            Surface(
                modifier = Modifier.height(48.dp),
                shape = RoundedCornerShape(10.dp),
                color = MaterialTheme.colorScheme.primary,
                onClick = { onConfirm(value) },
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
