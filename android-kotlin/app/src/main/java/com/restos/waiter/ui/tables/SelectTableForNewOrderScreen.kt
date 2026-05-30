package com.restos.waiter.ui.tables

import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.restos.waiter.data.orders.OrderStatus
import com.restos.waiter.data.tables.TableDto
import com.restos.waiter.data.tables.ZoneDto

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SelectTableForNewOrderScreen(
    onBack: () -> Unit,
    onPick: (tableId: String) -> Unit,
    viewModel: SelectTableViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            CenterAlignedTopAppBar(
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Назад")
                    }
                },
                title = { Text("Выберите стол", fontWeight = FontWeight.SemiBold) },
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { inner ->
        val groups = remember(state.tables, state.zones, state.orders, viewModel.myUserId) {
            buildGroups(state.tables, state.zones, state.orders, viewModel.myUserId)
        }

        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(inner),
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            if (groups.myTables.isNotEmpty()) {
                item {
                    Section(title = "Мои столы") {
                        TablesGrid(groups.myTables, highlight = true, onPick = onPick)
                    }
                }
            }
            groups.byZone.forEach { (zone, tables) ->
                item(key = "zone-${zone?.id ?: 0}") {
                    Section(title = zone?.name ?: "Зал") {
                        TablesGrid(tables, onPick = onPick)
                    }
                }
            }
            if (groups.noZone.isNotEmpty()) {
                item {
                    Section(title = "Без зоны") {
                        TablesGrid(groups.noZone, onPick = onPick)
                    }
                }
            }
            if (state.tables.isEmpty() && !state.loading) {
                item {
                    Text(
                        "Нет доступных столов. Создайте столы и зоны на десктопе.",
                        modifier = Modifier.fillMaxWidth().padding(top = 48.dp),
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                        fontSize = 14.sp,
                    )
                }
            }
        }
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            title.uppercase(),
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = 0.8.sp,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
            modifier = Modifier.padding(start = 4.dp),
        )
        content()
    }
}

@Composable
private fun TablesGrid(
    tables: List<TableDto>,
    highlight: Boolean = false,
    onPick: (String) -> Unit,
) {
    val rows = tables.chunked(5)
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        rows.forEach { row ->
            androidx.compose.foundation.layout.Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                row.forEach { t ->
                    Box(modifier = Modifier.weight(1f)) {
                        TablePickButton(t, highlight, onClick = { onPick(t.id) })
                    }
                }
                // Заполняем пустыми ячейками, чтобы сохранить сетку
                repeat(5 - row.size) {
                    Box(modifier = Modifier.weight(1f))
                }
            }
        }
    }
}

@Composable
private fun TablePickButton(
    table: TableDto,
    highlight: Boolean,
    onClick: () -> Unit,
) {
    val isFree = table.status == "free"
    val bg = when {
        highlight -> MaterialTheme.colorScheme.primary
        isFree -> MaterialTheme.colorScheme.surface
        else -> Color(0xFFFFFBEB)
    }
    val fg = when {
        highlight -> MaterialTheme.colorScheme.onPrimary
        isFree -> MaterialTheme.colorScheme.onSurface
        else -> Color(0xFFB45309)
    }
    val borderColor = when {
        highlight -> MaterialTheme.colorScheme.primary
        isFree -> MaterialTheme.colorScheme.surfaceVariant
        else -> Color(0xFFFCD34D)
    }
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .aspectRatio(1f)
            .border(1.dp, borderColor, RoundedCornerShape(12.dp)),
        shape = RoundedCornerShape(12.dp),
        color = bg,
        onClick = onClick,
    ) {
        Box(contentAlignment = Alignment.Center) {
            Text(
                text = table.name.ifBlank { table.number.toString() },
                fontWeight = FontWeight.Bold,
                fontSize = 14.sp,
                color = fg,
            )
        }
    }
}

private data class TableGroups(
    val myTables: List<TableDto>,
    val byZone: List<Pair<ZoneDto?, List<TableDto>>>,
    val noZone: List<TableDto>,
)

private fun buildGroups(
    tables: List<TableDto>,
    zones: List<ZoneDto>,
    orders: List<com.restos.waiter.data.orders.OrderDto>,
    myUserId: String?,
): TableGroups {
    val zonesById = zones.associateBy { it.id }

    val withZone = tables.filter { it.zone != null }
    val noZone = tables.filter { it.zone == null }
        .sortedWith(compareBy({ it.number }, { it.name }))

    val byZone = withZone
        .groupBy { it.zone }
        .map { (zid, ts) ->
            zonesById[zid] to ts.sortedWith(compareBy({ it.number }, { it.name }))
        }
        .sortedBy { it.first?.sortOrder ?: 0 }

    val myTables = if (myUserId == null) emptyList() else {
        val myTableIds = orders
            .filter { it.waiter == myUserId && OrderStatus.isActive(it.status) && it.table != null }
            .map { it.table!! }
            .toSet()
        tables.filter { it.id in myTableIds || it.waiter == myUserId }
            .sortedWith(compareBy({ it.number }, { it.name }))
    }

    return TableGroups(myTables = myTables, byZone = byZone, noZone = noZone)
}
