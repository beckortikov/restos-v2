package com.restos.zakup.ui.stock

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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.restos.zakup.ui.components.EmptyState
import com.restos.zakup.ui.components.ErrorState
import com.restos.zakup.ui.components.LoadingState
import com.restos.zakup.ui.components.ZakupCard
import com.restos.zakup.ui.shell.ZakupScreenHeader
import com.restos.zakup.ui.theme.ZakupColors
import com.restos.zakup.ui.theme.ZakupRadius
import com.restos.zakup.util.formatQty

/** Экран 03 «Склад» — остатки с выбором склада, быстрым фильтром и поиском. */
@Composable
fun StockScreen(viewModel: StockViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Column(Modifier.fillMaxSize()) {
        ZakupScreenHeader(title = "Склад")

        SearchField(state.query, viewModel::setQuery, Modifier.padding(horizontal = 20.dp))
        Spacer(Modifier.height(10.dp))

        // Быстрый фильтр по остатку (#4): Все / Мало / Нет.
        StatusChips(state.status, state.lowCount, state.outCount, viewModel::setStatus)
        Spacer(Modifier.height(8.dp))

        // Выбор склада (#5).
        if (state.warehouses.size > 1) {
            WarehouseChips(state.warehouses, state.selectedWarehouse, viewModel::selectWarehouse)
            Spacer(Modifier.height(8.dp))
        }

        when {
            state.loading -> LoadingState()
            state.error != null -> ErrorState(state.error!!, onRetry = viewModel::load)
            state.rows.isEmpty() -> EmptyState("Ничего не найдено")
            else -> LazyColumn(
                contentPadding = PaddingValues(horizontal = 20.dp, vertical = 4.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                items(state.rows, key = { it.id }) { row -> StockRowCard(row) }
            }
        }
    }
}

@Composable
private fun SearchField(value: String, onChange: (String) -> Unit, modifier: Modifier = Modifier) {
    TextField(
        value = value,
        onValueChange = onChange,
        modifier = modifier.fillMaxWidth(),
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
}

@Composable
private fun StatusChips(selected: StockStatusFilter, low: Int, out: Int, onSelect: (StockStatusFilter) -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 20.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        StockStatusFilter.entries.forEach { f ->
            val active = f == selected
            val count = when (f) { StockStatusFilter.All -> null; StockStatusFilter.Low -> low; StockStatusFilter.Out -> out }
            val accent = when (f) { StockStatusFilter.Low -> ZakupColors.Warn; StockStatusFilter.Out -> ZakupColors.Danger; else -> ZakupColors.TextPrimary }
            Surface(
                shape = RoundedCornerShape(ZakupRadius.pill),
                color = if (active) accent else ZakupColors.Surface,
                border = if (active) null else BorderStroke(1.dp, ZakupColors.Border),
                modifier = Modifier.weight(1f).clickable { onSelect(f) },
            ) {
                Row(Modifier.padding(vertical = 9.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        f.label + (count?.let { " $it" } ?: ""),
                        color = if (active) Color.White else ZakupColors.TextSecondary,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.SemiBold,
                    )
                }
            }
        }
    }
}

@Composable
private fun WarehouseChips(tabs: List<WarehouseTab>, selected: String?, onSelect: (String?) -> Unit) {
    LazyRow(
        contentPadding = PaddingValues(horizontal = 20.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(tabs, key = { it.id ?: "all" }) { tab ->
            val active = tab.id == selected
            Surface(
                shape = RoundedCornerShape(ZakupRadius.pill),
                color = if (active) ZakupColors.TextPrimary else ZakupColors.Surface,
                border = if (active) null else BorderStroke(1.dp, ZakupColors.Border),
                modifier = Modifier.clickable { onSelect(tab.id) },
            ) {
                Text(
                    tab.name,
                    color = if (active) Color.White else ZakupColors.TextSecondary,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                )
            }
        }
    }
}

@Composable
private fun StockRowCard(row: StockRow) {
    val dot = when (row.level) {
        StockLevel.Ok -> ZakupColors.Primary
        StockLevel.Low -> ZakupColors.Warn
        StockLevel.Out -> ZakupColors.Danger
    }
    ZakupCard(Modifier.fillMaxWidth(), padding = 14) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(10.dp).background(dot, CircleShape))
            Spacer(Modifier.size(12.dp))
            Column(Modifier.weight(1f)) {
                Text(row.name, style = MaterialTheme.typography.titleMedium)
                Spacer(Modifier.size(2.dp))
                Text(row.category, fontSize = 12.5.sp, color = ZakupColors.TextTertiary)
            }
            Column(horizontalAlignment = Alignment.End) {
                Text(
                    formatQty(row.qty, row.unit),
                    fontSize = 15.sp,
                    fontWeight = FontWeight.Bold,
                    color = if (row.level == StockLevel.Out) ZakupColors.Danger else ZakupColors.TextPrimary,
                )
                if (row.level != StockLevel.Ok && row.minQty.signum() > 0) {
                    Spacer(Modifier.size(2.dp))
                    Text("мин ${formatQty(row.minQty, row.unit)}", fontSize = 11.5.sp, color = ZakupColors.TextTertiary)
                }
            }
        }
    }
}
