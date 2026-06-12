package com.restos.waiter.ui.composer

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
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

@Composable
fun GuestsDialog(
    onDismiss: () -> Unit,
    onPick: (Int) -> Unit,
) {
    // Режим «больше 6»: показываем счётчик 7..99 вместо сетки 1–6.
    var bigMode by remember { mutableStateOf(false) }
    var bigCount by remember { mutableStateOf(7) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Сколько гостей?", fontWeight = FontWeight.SemiBold) },
        text = {
            if (!bigMode) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    // Быстрые кнопки 1–6 (две строки по 3).
                    listOf(listOf(1, 2, 3), listOf(4, 5, 6)).forEach { row ->
                        Row(
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            row.forEach { n ->
                                GuestsButton(n.toString(), modifier = Modifier.weight(1f)) { onPick(n) }
                            }
                        }
                    }
                    // «Больше 6» — открывает счётчик.
                    Surface(
                        modifier = Modifier.fillMaxWidth().height(52.dp),
                        shape = RoundedCornerShape(10.dp),
                        color = MaterialTheme.colorScheme.primary.copy(alpha = 0.12f),
                        onClick = { bigMode = true },
                    ) {
                        Box(contentAlignment = Alignment.Center) {
                            Text(
                                "Больше 6",
                                fontSize = 16.sp,
                                fontWeight = FontWeight.SemiBold,
                                color = MaterialTheme.colorScheme.primary,
                            )
                        }
                    }
                }
            } else {
                // Счётчик для больших групп: − [N] +
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        StepButton("−", modifier = Modifier.size(56.dp)) {
                            if (bigCount > 7) bigCount--
                        }
                        Text(
                            bigCount.toString(),
                            fontSize = 32.sp,
                            fontWeight = FontWeight.Bold,
                        )
                        StepButton("+", modifier = Modifier.size(56.dp)) {
                            if (bigCount < 99) bigCount++
                        }
                    }
                    Surface(
                        modifier = Modifier.fillMaxWidth().height(52.dp),
                        shape = RoundedCornerShape(10.dp),
                        color = MaterialTheme.colorScheme.primary,
                        onClick = { onPick(bigCount) },
                    ) {
                        Box(contentAlignment = Alignment.Center) {
                            Text(
                                "Готово — $bigCount гостей",
                                fontSize = 16.sp,
                                fontWeight = FontWeight.SemiBold,
                                color = MaterialTheme.colorScheme.onPrimary,
                            )
                        }
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = {
            TextButton(onClick = { if (bigMode) bigMode = false else onDismiss() }) {
                Text(if (bigMode) "Назад" else "Отмена")
            }
        },
    )
}

@Composable
private fun GuestsButton(label: String, modifier: Modifier, onClick: () -> Unit) {
    Surface(
        modifier = modifier.aspectRatio(1.6f),
        shape = RoundedCornerShape(10.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
        onClick = onClick,
    ) {
        Box(contentAlignment = Alignment.Center) {
            Text(label, fontSize = 20.sp, fontWeight = FontWeight.Bold)
        }
    }
}

@Composable
private fun StepButton(label: String, modifier: Modifier, onClick: () -> Unit) {
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
