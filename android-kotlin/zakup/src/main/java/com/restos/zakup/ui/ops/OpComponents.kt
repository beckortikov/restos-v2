package com.restos.zakup.ui.ops

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.restos.zakup.ui.components.ZakupTopBar
import com.restos.zakup.ui.theme.ZakupColors
import com.restos.zakup.ui.theme.ZakupRadius

/** Позиция для выбора в операциях (списание/остаток/хозрасход/инвентаризация). */
data class PickItem(
    val id: String,
    val name: String,
    val unit: String?,
    val secondary: String?, // «остаток 12 л · 12 000/л» и т.п.
)

/** Ряд чипов-оснований (причина операции). */
@Composable
fun ReasonChips(reasons: List<String>, selected: String, onSelect: (String) -> Unit, activeColor: Color = ZakupColors.TextPrimary) {
    LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        items(reasons, key = { it }) { r ->
            val active = r == selected
            val soft = activeColor != ZakupColors.TextPrimary
            Surface(
                shape = RoundedCornerShape(ZakupRadius.pill),
                color = when { !active -> ZakupColors.Surface; soft -> activeColor.copy(alpha = 0.1f); else -> activeColor },
                border = when { active && soft -> BorderStroke(1.dp, activeColor); active -> null; else -> BorderStroke(1.dp, ZakupColors.Border) },
                modifier = Modifier.clickable { onSelect(r) },
            ) {
                Text(
                    r,
                    color = when { !active -> ZakupColors.TextSecondary; soft -> activeColor; else -> Color.White },
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
                )
            }
        }
    }
}

/** Числовое поле в стиле макета (soft-фон, суффикс-единица). */
@Composable
fun OpNumField(value: String, onChange: (String) -> Unit, placeholder: String, suffix: String?, modifier: Modifier = Modifier) {
    Surface(shape = RoundedCornerShape(ZakupRadius.small), color = ZakupColors.SurfaceMuted, modifier = modifier) {
        Row(Modifier.padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            TextField(
                value = value,
                onValueChange = onChange,
                placeholder = { Text(placeholder, color = ZakupColors.TextTertiary, fontSize = 14.sp) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                modifier = Modifier.weight(1f),
                colors = TextFieldDefaults.colors(
                    focusedContainerColor = Color.Transparent,
                    unfocusedContainerColor = Color.Transparent,
                    focusedIndicatorColor = Color.Transparent,
                    unfocusedIndicatorColor = Color.Transparent,
                    focusedTextColor = ZakupColors.TextPrimary,
                    unfocusedTextColor = ZakupColors.TextPrimary,
                ),
            )
            if (suffix != null) Text(suffix, fontSize = 12.sp, color = ZakupColors.TextTertiary, modifier = Modifier.padding(end = 10.dp))
        }
    }
}

/** Нижняя плашка «итого + кнопка действия». */
@Composable
fun OpSubmitBar(
    totalLabel: String,
    totalValue: String,
    totalColor: Color,
    button: String,
    enabled: Boolean,
    submitting: Boolean,
    onSubmit: () -> Unit,
    modifier: Modifier = Modifier,
    accentColor: Color = ZakupColors.Primary,
) {
    Surface(color = ZakupColors.Bg, modifier = modifier.fillMaxWidth()) {
        Column(Modifier.padding(20.dp).navigationBarsPadding()) {
            Row(Modifier.fillMaxWidth().padding(bottom = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(totalLabel, fontSize = 14.sp, color = ZakupColors.TextSecondary, modifier = Modifier.weight(1f))
                Text(totalValue, fontSize = 18.sp, fontWeight = FontWeight.Bold, color = totalColor)
            }
            Surface(
                onClick = onSubmit,
                enabled = enabled,
                shape = RoundedCornerShape(ZakupRadius.button),
                color = if (enabled) accentColor else accentColor.copy(alpha = 0.4f),
                modifier = Modifier.fillMaxWidth().height(54.dp),
            ) {
                Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                    if (submitting) CircularProgressIndicator(color = ZakupColors.OnPrimary, strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
                    else Text(button, color = ZakupColors.OnPrimary, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                }
            }
        }
    }
}

/** Оверлей выбора ингредиентов: поиск + тап-переключение. */
@Composable
fun IngredientPickerOverlay(
    title: String,
    items: List<PickItem>,
    isAdded: (String) -> Boolean,
    onToggle: (PickItem) -> Unit,
    onClose: () -> Unit,
) {
    var query by remember { mutableStateOf("") }
    val filtered = items.filter { query.isBlank() || it.name.contains(query.trim(), ignoreCase = true) }

    Surface(Modifier.fillMaxSize(), color = ZakupColors.Bg) {
        Column(Modifier.fillMaxSize().statusBarsPadding()) {
            ZakupTopBar(title, onBack = onClose)
            TextField(
                value = query,
                onValueChange = { query = it },
                modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp),
                placeholder = { Text("Поиск ингредиента", color = ZakupColors.TextTertiary, fontSize = 14.sp) },
                leadingIcon = { Icon(Icons.Outlined.Search, contentDescription = null, tint = ZakupColors.TextTertiary) },
                singleLine = true,
                shape = RoundedCornerShape(ZakupRadius.tile),
                colors = TextFieldDefaults.colors(
                    focusedContainerColor = ZakupColors.Surface,
                    unfocusedContainerColor = ZakupColors.Surface,
                    focusedIndicatorColor = Color.Transparent,
                    unfocusedIndicatorColor = Color.Transparent,
                    focusedTextColor = ZakupColors.TextPrimary,
                    unfocusedTextColor = ZakupColors.TextPrimary,
                ),
            )
            Spacer(Modifier.height(10.dp))
            LazyColumn(
                contentPadding = PaddingValues(horizontal = 20.dp, vertical = 4.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                items(filtered, key = { it.id }) { item ->
                    val added = isAdded(item.id)
                    Surface(
                        shape = RoundedCornerShape(ZakupRadius.card),
                        color = ZakupColors.Surface,
                        border = BorderStroke(1.dp, if (added) ZakupColors.Primary else ZakupColors.Border),
                        modifier = Modifier.fillMaxWidth().clickable { onToggle(item) },
                    ) {
                        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(item.name, style = MaterialTheme.typography.titleMedium)
                                if (item.secondary != null) {
                                    Spacer(Modifier.size(2.dp))
                                    Text(item.secondary, fontSize = 12.5.sp, color = ZakupColors.TextTertiary)
                                }
                            }
                            Surface(
                                shape = RoundedCornerShape(ZakupRadius.chip),
                                color = if (added) ZakupColors.PrimarySoft else ZakupColors.Primary,
                                modifier = Modifier.size(36.dp),
                            ) {
                                Box(contentAlignment = Alignment.Center) {
                                    Icon(
                                        if (added) Icons.Outlined.Check else Icons.Outlined.Add,
                                        contentDescription = null,
                                        tint = if (added) ZakupColors.Primary else ZakupColors.OnPrimary,
                                        modifier = Modifier.size(18.dp),
                                    )
                                }
                            }
                        }
                    }
                }
                item { Spacer(Modifier.height(24.dp)) }
            }
        }
    }
}
