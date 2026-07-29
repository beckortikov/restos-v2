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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Circle
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.Remove
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Store
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
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
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.restos.zakup.ui.components.ZakupTopBar
import com.restos.zakup.ui.stock.WarehouseTab
import com.restos.zakup.ui.theme.ZakupColors
import com.restos.zakup.ui.theme.ZakupRadius
import com.restos.zakup.util.formatQty
import java.math.BigDecimal

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

/** Числовое поле в стиле макета (soft-фон, суффикс-единица). borderColor — подсветка по знаку расхождения (инвентаризация). */
@Composable
fun OpNumField(value: String, onChange: (String) -> Unit, placeholder: String, suffix: String?, modifier: Modifier = Modifier, borderColor: Color? = null) {
    Surface(
        shape = RoundedCornerShape(ZakupRadius.small),
        color = ZakupColors.SurfaceMuted,
        border = borderColor?.let { BorderStroke(1.5.dp, it) },
        modifier = modifier,
    ) {
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
    icon: ImageVector? = null,
    secondaryButton: String? = null,
    onSecondary: (() -> Unit)? = null,
    hint: String? = null,
) {
    Surface(color = ZakupColors.Bg, modifier = modifier.fillMaxWidth()) {
        Column(Modifier.padding(20.dp).navigationBarsPadding()) {
            Row(Modifier.fillMaxWidth().padding(bottom = if (hint != null && !submitting) 8.dp else 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(totalLabel, fontSize = 14.sp, color = ZakupColors.TextSecondary, modifier = Modifier.weight(1f))
                Text(totalValue, fontSize = 18.sp, fontWeight = FontWeight.Bold, color = totalColor)
            }
            // Подсказка, почему кнопка ещё не активна — вместо немого отключения.
            if (hint != null && !submitting) {
                Text(hint, fontSize = 12.5.sp, color = ZakupColors.Warn, modifier = Modifier.padding(bottom = 8.dp))
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                if (secondaryButton != null && onSecondary != null) {
                    Surface(
                        onClick = onSecondary,
                        enabled = !submitting,
                        shape = RoundedCornerShape(ZakupRadius.button),
                        color = ZakupColors.Surface,
                        border = BorderStroke(1.dp, ZakupColors.Border),
                        modifier = Modifier.weight(1f).height(54.dp),
                    ) {
                        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                            Text(secondaryButton, color = ZakupColors.TextPrimary, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                        }
                    }
                }
                Surface(
                    onClick = onSubmit,
                    enabled = enabled,
                    shape = RoundedCornerShape(ZakupRadius.button),
                    color = if (enabled) accentColor else accentColor.copy(alpha = 0.4f),
                    modifier = Modifier.weight(if (secondaryButton != null) 1.4f else 1f).height(54.dp),
                ) {
                    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                        if (submitting) {
                            CircularProgressIndicator(color = ZakupColors.OnPrimary, strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
                        } else {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                if (icon != null) {
                                    Icon(icon, contentDescription = null, tint = ZakupColors.OnPrimary, modifier = Modifier.size(18.dp))
                                    Spacer(Modifier.size(8.dp))
                                }
                                Text(button, color = ZakupColors.OnPrimary, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                            }
                        }
                    }
                }
            }
        }
    }
}

/** Строка-селектор склада (иконка+название+шеврон), тап открывает выпадающий список. */
@Composable
fun WarehouseSelectorRow(warehouses: List<WarehouseTab>, selected: String?, onSelect: (String?) -> Unit, modifier: Modifier = Modifier) {
    var expanded by remember { mutableStateOf(false) }
    val label = warehouses.firstOrNull { it.id == selected }?.name ?: warehouses.firstOrNull()?.name ?: "Склад"
    Box(modifier) {
        Surface(
            onClick = { expanded = true },
            shape = RoundedCornerShape(ZakupRadius.tile),
            color = ZakupColors.Surface,
            border = BorderStroke(1.dp, ZakupColors.Border),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.Store, contentDescription = null, tint = ZakupColors.TextSecondary, modifier = Modifier.size(18.dp))
                Spacer(Modifier.size(10.dp))
                Text(label, fontSize = 14.5.sp, fontWeight = FontWeight.SemiBold, color = ZakupColors.TextPrimary, modifier = Modifier.weight(1f))
                Icon(Icons.Outlined.KeyboardArrowDown, contentDescription = null, tint = ZakupColors.TextTertiary, modifier = Modifier.size(20.dp))
            }
        }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            warehouses.forEach { w ->
                DropdownMenuItem(text = { Text(w.name) }, onClick = { onSelect(w.id); expanded = false })
            }
        }
    }
}

/** Компактный чип-склад для AppBar (инвентаризация). */
@Composable
fun WarehouseChip(warehouses: List<WarehouseTab>, selected: String?, onSelect: (String?) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    val label = warehouses.firstOrNull { it.id == selected }?.name ?: warehouses.firstOrNull()?.name ?: "Склад"
    Box {
        Surface(
            onClick = { expanded = true },
            shape = RoundedCornerShape(ZakupRadius.pill),
            color = ZakupColors.SurfaceMuted,
        ) {
            Row(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(label, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = ZakupColors.TextPrimary)
                Icon(Icons.Outlined.KeyboardArrowDown, contentDescription = null, tint = ZakupColors.TextSecondary, modifier = Modifier.size(18.dp))
            }
        }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            warehouses.forEach { w ->
                DropdownMenuItem(text = { Text(w.name) }, onClick = { onSelect(w.id); expanded = false })
            }
        }
    }
}

/**
 * Чекбокс + степпер кол-ва в одной строке (09/10) — тап по кружку переключает
 * включено/выключено (0 ↔ полный доступный объём), +/- подстраивает точечно.
 */
@Composable
fun CheckStepperRow(
    checked: Boolean,
    qtyLabel: String,
    checkedColor: Color,
    onToggle: () -> Unit,
    onDec: () -> Unit,
    onInc: () -> Unit,
) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(
            if (checked) Icons.Filled.CheckCircle else Icons.Outlined.Circle,
            contentDescription = null,
            tint = if (checked) checkedColor else ZakupColors.Border,
            modifier = Modifier.size(22.dp).clickable(onClick = onToggle),
        )
        Spacer(Modifier.size(10.dp))
        Surface(onClick = onDec, shape = CircleShape, color = ZakupColors.SurfaceMuted, modifier = Modifier.size(26.dp)) {
            Box(contentAlignment = Alignment.Center) {
                Icon(Icons.Outlined.Remove, contentDescription = null, tint = ZakupColors.TextSecondary, modifier = Modifier.size(14.dp))
            }
        }
        Text(
            qtyLabel,
            fontSize = 13.5.sp,
            fontWeight = FontWeight.SemiBold,
            color = ZakupColors.TextPrimary,
            modifier = Modifier.padding(horizontal = 8.dp).width(60.dp),
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
        Surface(onClick = onInc, shape = CircleShape, color = ZakupColors.SurfaceMuted, modifier = Modifier.size(26.dp)) {
            Box(contentAlignment = Alignment.Center) {
                Icon(Icons.Outlined.Add, contentDescription = null, tint = ZakupColors.TextSecondary, modifier = Modifier.size(14.dp))
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
