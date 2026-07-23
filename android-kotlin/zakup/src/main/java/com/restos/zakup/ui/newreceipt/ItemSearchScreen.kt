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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.restos.zakup.ui.components.ZakupTopBar
import com.restos.zakup.ui.theme.ZakupColors
import com.restos.zakup.ui.theme.ZakupRadius
import com.restos.zakup.util.formatMoney

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

    Surface(Modifier.fillMaxSize(), color = ZakupColors.Bg) {
        Column(Modifier.fillMaxSize().statusBarsPadding()) {
            ZakupTopBar("Позиции приёмки", onBack = onClose)

            TextField(
                value = state.searchQuery,
                onValueChange = viewModel::setSearchQuery,
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
                    contentPadding = PaddingValues(horizontal = 20.dp, vertical = 4.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    items(filtered, key = { it.id }) { item ->
                        ItemRow(
                            item = item,
                            added = state.lines.any { it.ingredientId == item.id },
                            onAdd = { viewModel.addItem(item) },
                            onRemove = { viewModel.removeLine(item.id) },
                        )
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
        contentPadding = PaddingValues(horizontal = 20.dp),
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
            Text("$count", color = if (active) Color.White.copy(alpha = 0.7f) else ZakupColors.TextTertiary, fontSize = 12.sp, fontWeight = FontWeight.Bold)
        }
    }
}

@Composable
private fun ItemRow(item: SearchItem, added: Boolean, onAdd: () -> Unit, onRemove: () -> Unit) {
    Surface(
        shape = RoundedCornerShape(ZakupRadius.card),
        color = ZakupColors.Surface,
        border = BorderStroke(1.dp, if (added) ZakupColors.Primary else ZakupColors.Border),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(item.name, style = MaterialTheme.typography.titleMedium)
                Spacer(Modifier.size(2.dp))
                Text(
                    "цена ${formatMoney(item.price, "")}${item.unit?.let { "/$it" } ?: ""}",
                    fontSize = 12.5.sp,
                    color = ZakupColors.TextTertiary,
                )
            }
            Surface(
                onClick = if (added) onRemove else onAdd,
                shape = RoundedCornerShape(ZakupRadius.chip),
                color = if (added) ZakupColors.PrimarySoft else ZakupColors.Primary,
                modifier = Modifier.size(40.dp),
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(
                        if (added) Icons.Outlined.Check else Icons.Outlined.Add,
                        contentDescription = if (added) "Добавлено" else "Добавить",
                        tint = if (added) ZakupColors.Primary else ZakupColors.OnPrimary,
                        modifier = Modifier.size(20.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun DoneBar(count: Int, total: java.math.BigDecimal, onDone: () -> Unit, modifier: Modifier) {
    Surface(color = ZakupColors.Bg, modifier = modifier.fillMaxWidth()) {
        Box(Modifier.padding(20.dp).navigationBarsPadding()) {
            Surface(
                onClick = onDone,
                shape = RoundedCornerShape(ZakupRadius.button),
                color = ZakupColors.Primary,
                modifier = Modifier.fillMaxWidth().height(54.dp),
            ) {
                Row(Modifier.fillMaxSize().padding(horizontal = 18.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("$count позиций · ${formatMoney(total, "")}", color = ZakupColors.OnPrimary, fontSize = 14.5.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                    Text("Готово", color = ZakupColors.OnPrimary, fontSize = 15.sp, fontWeight = FontWeight.Bold)
                }
            }
        }
    }
}
