package com.restos.zakup.ui.newreceipt

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Remove
import androidx.compose.material.icons.outlined.Search
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
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.restos.zakup.ui.components.RowDivider
import com.restos.zakup.ui.components.ZakupCard
import com.restos.zakup.ui.components.ZakupTopBar
import com.restos.zakup.ui.theme.ZakupColors
import com.restos.zakup.ui.theme.ZakupRadius
import com.restos.zakup.util.formatMoney
import com.restos.zakup.util.formatQty
import com.restos.zakup.util.toDecimalOrZero
import java.math.BigDecimal

/** Экран 14 «Позиции приёмки» — вкладки по складам, поиск, добавление в 1 тап. */
@Composable
fun ItemSearchScreen(
    viewModel: NewReceiptViewModel,
    onClose: () -> Unit,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    val counts = remember(state.searchItems) {
        state.searchItems.groupingBy { it.kind }.eachCount()
    }
    val filtered = state.searchItems.filter { item ->
        (state.searchTab == null || item.kind == state.searchTab) &&
            (state.searchQuery.isBlank() || item.name.contains(state.searchQuery.trim(), ignoreCase = true))
    }
    val addedCount = state.lines.size
    var showNewItem by remember { mutableStateOf(false) }

    if (showNewItem) {
        NewItemSheet(
            initialName = state.searchQuery,
            creating = state.creatingItem,
            error = state.newItemError,
            existingItems = state.searchItems,
            onDismiss = { showNewItem = false; viewModel.clearNewItemError() },
            onCreate = { name, unit, isFood, price ->
                viewModel.createIngredient(name, unit, isFood, price) { showNewItem = false }
            },
        )
    }

    Surface(Modifier.fillMaxSize(), color = ZakupColors.Bg) {
        Column(Modifier.fillMaxSize().statusBarsPadding()) {
            ZakupTopBar("Позиции приёмки", onBack = onClose)
            if (!state.supplierName.isNullOrBlank()) {
                Text(
                    state.supplierName!!,
                    fontSize = 12.5.sp,
                    color = ZakupColors.TextTertiary,
                    modifier = Modifier.padding(start = 20.dp, bottom = 8.dp),
                )
            }

            Row(
                Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextField(
                    value = state.searchQuery,
                    onValueChange = viewModel::setSearchQuery,
                    modifier = Modifier.weight(1f),
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
                Spacer(Modifier.size(8.dp))
                // Нет в списке? Создать новый товар (продукт/хозтовар).
                Surface(
                    onClick = { showNewItem = true },
                    shape = RoundedCornerShape(ZakupRadius.tile),
                    color = ZakupColors.PrimarySoft,
                    modifier = Modifier.size(52.dp),
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        Icon(Icons.Outlined.Add, contentDescription = "Новый товар", tint = ZakupColors.Primary, modifier = Modifier.size(24.dp))
                    }
                }
            }
            Spacer(Modifier.height(12.dp))

            WarehouseTabs(
                selected = state.searchTab,
                total = state.searchItems.size,
                counts = counts,
                onSelect = viewModel::setSearchTab,
            )
            Spacer(Modifier.height(8.dp))

            Box(Modifier.weight(1f)) {
                LazyColumn(
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    if (filtered.isNotEmpty()) {
                        item {
                            ZakupCard(Modifier.fillMaxWidth()) {
                                Column {
                                    filtered.forEachIndexed { i, item ->
                                        val line = state.lines.find { it.ingredientId == item.id }
                                        ItemRow(
                                            item = item,
                                            line = line,
                                            onAdd = { viewModel.addItem(item) },
                                            onRemove = { viewModel.removeLine(item.id) },
                                            onQty = { viewModel.setQty(item.id, it) },
                                        )
                                        if (i < filtered.lastIndex) RowDivider()
                                    }
                                }
                            }
                        }
                    }
                    item { Spacer(Modifier.height(72.dp)) }
                }

                if (addedCount > 0) {
                    DoneBar(
                        count = addedCount,
                        total = state.total,
                        onDone = onClose,
                        modifier = Modifier.align(Alignment.BottomCenter),
                    )
                }
            }
        }
    }
}

@Composable
private fun WarehouseTabs(
    selected: WarehouseKind?,
    total: Int,
    counts: Map<WarehouseKind, Int>,
    onSelect: (WarehouseKind?) -> Unit,
) {
    LazyRow(
        contentPadding = PaddingValues(horizontal = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        item { Tab("Все", total, active = selected == null) { onSelect(null) } }
        items(
            listOf(WarehouseKind.Products, WarehouseKind.Purchased, WarehouseKind.Supplies),
            key = { it.name },
        ) { kind ->
            Tab(kind.label, counts[kind] ?: 0, active = selected == kind) { onSelect(kind) }
        }
    }
}

@Composable
private fun Tab(label: String, count: Int, active: Boolean, onClick: () -> Unit) {
    Surface(
        shape = RoundedCornerShape(ZakupRadius.pill),
        color = if (active) ZakupColors.TextPrimary else ZakupColors.Surface,
        border = if (active) null else BorderStroke(1.dp, ZakupColors.Border),
        modifier = Modifier.clickable(onClick = onClick),
    ) {
        Row(
            Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(label, color = if (active) Color.White else ZakupColors.TextSecondary, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.size(6.dp))
            Surface(
                shape = RoundedCornerShape(6.dp),
                color = if (active) Color.White.copy(alpha = 0.15f) else ZakupColors.SurfaceMuted,
            ) {
                Text(
                    "$count",
                    color = if (active) Color.White else ZakupColors.TextTertiary,
                    fontSize = 11.5.sp,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                )
            }
        }
    }
}

@Composable
private fun ItemRow(item: SearchItem, line: DraftLine?, onAdd: () -> Unit, onRemove: () -> Unit, onQty: (String) -> Unit) {
    val added = line != null
    Row(
        Modifier
            .fillMaxWidth()
            .background(if (added) ZakupColors.PrimarySoft else ZakupColors.Surface)
            .clickable(enabled = !added, onClick = onAdd)
            .padding(14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Surface(
            shape = RoundedCornerShape(ZakupRadius.chip),
            color = if (added) ZakupColors.Primary else ZakupColors.Surface,
            border = if (added) null else BorderStroke(1.dp, ZakupColors.Border),
            modifier = Modifier.size(38.dp),
        ) {
            Box(contentAlignment = Alignment.Center) {
                if (added) {
                    Icon(Icons.Outlined.Check, contentDescription = "Добавлено", tint = ZakupColors.OnPrimary, modifier = Modifier.size(18.dp))
                } else {
                    Icon(Icons.Outlined.Add, contentDescription = "Добавить", tint = ZakupColors.TextSecondary, modifier = Modifier.size(18.dp))
                }
            }
        }
        Spacer(Modifier.size(12.dp))
        Column(Modifier.weight(1f)) {
            Text(item.name, style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.size(2.dp))
            if (added) {
                Text("Добавлено в приёмку", fontSize = 12.5.sp, color = ZakupColors.Primary)
            } else {
                Text(
                    "${item.kind.label} · остаток ${formatQty(item.stock, item.unit)}",
                    fontSize = 12.5.sp,
                    color = ZakupColors.TextTertiary,
                )
            }
        }
        if (added) {
            QtyStepper(
                qtyText = line!!.qty,
                unit = item.unit,
                onQtyText = onQty,
                onZeroOrBelow = onRemove,
            )
        }
    }
}

/**
 * Инлайн-степпер кол-ва (#14) — доступен сразу в результатах поиска, без
 * возврата в приёмку. Поле между +/- принимает свободный ввод с клавиатуры
 * (набрать «100», а не тапнуть «+» сто раз).
 */
@Composable
private fun QtyStepper(qtyText: String, unit: String?, onQtyText: (String) -> Unit, onZeroOrBelow: () -> Unit) {
    val qty = qtyText.toDecimalOrZero()
    val step = BigDecimal.ONE
    Row(verticalAlignment = Alignment.CenterVertically) {
        StepBtn(Icons.Outlined.Remove) {
            val next = qty - step
            if (next.signum() <= 0) onZeroOrBelow() else onQtyText(next.stripTrailingZeros().toPlainString())
        }
        com.restos.zakup.ui.ops.QtyEditField(value = qtyText, onChange = onQtyText, width = 48.dp)
        if (!unit.isNullOrBlank()) {
            Text(unit, fontSize = 11.sp, color = ZakupColors.TextTertiary, modifier = Modifier.padding(start = 4.dp, end = 4.dp))
        }
        StepBtn(Icons.Outlined.Add) { onQtyText((qty + step).stripTrailingZeros().toPlainString()) }
    }
}

@Composable
private fun StepBtn(icon: androidx.compose.ui.graphics.vector.ImageVector, onClick: () -> Unit) {
    Surface(onClick = onClick, shape = RoundedCornerShape(ZakupRadius.badge), color = ZakupColors.Surface, border = BorderStroke(1.dp, ZakupColors.Border), modifier = Modifier.size(26.dp)) {
        Box(contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription = null, tint = ZakupColors.TextSecondary, modifier = Modifier.size(14.dp))
        }
    }
}

@Composable
private fun DoneBar(count: Int, total: java.math.BigDecimal, onDone: () -> Unit, modifier: Modifier) {
    Surface(color = ZakupColors.Bg, modifier = modifier.fillMaxWidth()) {
        Row(
            Modifier.padding(16.dp).navigationBarsPadding(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text("$count позиций", fontSize = 12.5.sp, color = ZakupColors.TextTertiary)
                Text(formatMoney(total), fontSize = 15.sp, fontWeight = FontWeight.Bold, color = ZakupColors.TextPrimary)
            }
            Spacer(Modifier.size(12.dp))
            Surface(
                onClick = onDone,
                shape = RoundedCornerShape(ZakupRadius.button),
                color = ZakupColors.Primary,
                modifier = Modifier.height(48.dp),
            ) {
                Box(Modifier.padding(horizontal = 24.dp), contentAlignment = Alignment.Center) {
                    Text("Готово", color = ZakupColors.OnPrimary, fontSize = 15.sp, fontWeight = FontWeight.Bold)
                }
            }
        }
    }
}
