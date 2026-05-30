package com.restos.waiter.ui.orders

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Receipt
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.restos.waiter.data.orders.OrderDto
import com.restos.waiter.data.orders.OrderStatus
import com.restos.waiter.data.preferences.TablesTab
import com.restos.waiter.data.preferences.ViewMode
import com.restos.waiter.util.formatCurrency
import com.restos.waiter.util.formatTimeSince
import java.math.BigDecimal

@Composable
fun ActiveOrdersScreen(
    onOpenOrder: (orderId: String) -> Unit,
    viewModel: ActiveOrdersViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val viewMode by viewModel.viewMode.collectAsStateWithLifecycle()
    val visible = remember(state.orders, state.tab) { viewModel.visible() }

    Column(modifier = Modifier.fillMaxSize()) {
        TabsRow(
            state.tab,
            onSelect = viewModel::setTab,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
        )
        Spacer(Modifier.height(4.dp))

        Column(modifier = Modifier.padding(horizontal = 12.dp)) {
            when {
                state.loading && visible.isEmpty() -> SkeletonList()
                visible.isEmpty() -> EmptyState()
                viewMode == ViewMode.Grid -> OrdersGrid(visible, onOpenOrder)
                else -> OrdersList(visible, onOpenOrder)
            }
        }
    }
}

@Composable
private fun TabsRow(
    active: TablesTab,
    onSelect: (TablesTab) -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(40.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f))
            .padding(4.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        TabPill("Мои заказы", active == TablesTab.Mine, Modifier.weight(1f)) {
            onSelect(TablesTab.Mine)
        }
        TabPill("Все заказы", active == TablesTab.All, Modifier.weight(1f)) {
            onSelect(TablesTab.All)
        }
    }
}

@Composable
private fun TabPill(label: String, active: Boolean, modifier: Modifier, onClick: () -> Unit) {
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(8.dp),
        color = if (active) MaterialTheme.colorScheme.surface else Color.Transparent,
        shadowElevation = if (active) 1.dp else 0.dp,
        onClick = onClick,
    ) {
        Box(contentAlignment = Alignment.Center, modifier = Modifier.fillMaxSize()) {
            Text(
                label,
                fontSize = 14.sp,
                fontWeight = FontWeight.Medium,
                color = if (active) MaterialTheme.colorScheme.onSurface
                else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f),
            )
        }
    }
}

@Composable
private fun OrdersList(orders: List<OrderDto>, onOpen: (String) -> Unit) {
    LazyColumn(
        verticalArrangement = Arrangement.spacedBy(12.dp),
        contentPadding = PaddingValues(bottom = 16.dp),
    ) {
        items(orders, key = { it.id }) { order ->
            OrderRowCard(order, compact = false) { onOpen(order.id) }
        }
    }
}

@Composable
private fun OrdersGrid(orders: List<OrderDto>, onOpen: (String) -> Unit) {
    LazyVerticalGrid(
        columns = GridCells.Fixed(2),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        contentPadding = PaddingValues(bottom = 16.dp),
    ) {
        items(orders, key = { it.id }) { order ->
            OrderRowCard(order, compact = true) { onOpen(order.id) }
        }
    }
}

@Composable
private fun OrderRowCard(order: OrderDto, compact: Boolean = false, onClick: () -> Unit) {
    val isBill = order.status == OrderStatus.BILL_REQUESTED
    val borderColor = if (isBill) Color(0xFFDDD6FE) else MaterialTheme.colorScheme.surfaceVariant
    // OrderSlim из списка не содержит items (slim-endpoint), используем
    // server-computed itemsCount. Для OrderDetail (envelope) — fallback на items.size.
    val itemCount = if (order.items.isNotEmpty()) order.items.count { it.cancelledAt == null }
        else order.itemsCount
    val timeLabel = runCatching {
        formatTimeSince(java.time.Instant.parse(order.createdAt).toEpochMilli())
    }.getOrDefault("")
    val totalLabel = formatCurrency(order.total.toBigDecimalSafe())

    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .let { if (compact) it.height(155.dp) else it }
            .border(
                if (isBill) 2.dp else 1.dp,
                if (isBill) Color(0xFF8B5CF6) else borderColor,
                RoundedCornerShape(12.dp),
            ),
        shape = RoundedCornerShape(12.dp),
        color = MaterialTheme.colorScheme.surface,
        onClick = onClick,
    ) {
        if (compact) {
            OrderCompactBody(
                title = order.tableName ?: order.orderNumber?.let { "Заказ №$it" } ?: "Заказ",
                zone = order.tableZoneName,
                waiterName = order.waiterName,
                isBill = isBill,
                totalLabel = totalLabel,
                guestsCount = order.guestsCount,
                items = order.items.filter { it.cancelledAt == null },
                timeLabel = timeLabel,
            )
        } else {
            Box(modifier = Modifier.padding(12.dp).fillMaxSize()) {
                OrderListBody(
                    title = order.tableName ?: order.orderNumber?.let { "Заказ №$it" } ?: "Заказ",
                    zone = order.tableZoneName,
                    waiterName = order.waiterName,
                    totalLabel = totalLabel,
                    itemsCount = itemCount,
                    timeLabel = timeLabel,
                )
                if (isBill) {
                    StatusPill(
                        text = "СЧЁТ",
                        bg = Color(0xFF8B5CF6),
                        fg = Color.White,
                        modifier = Modifier.align(Alignment.TopEnd),
                    )
                }
            }
        }
    }
}

@Composable
private fun StatusPill(text: String, bg: Color, fg: Color, modifier: Modifier = Modifier) {
    Surface(modifier = modifier, color = bg, shape = RoundedCornerShape(50)) {
        Text(
            text,
            color = fg,
            fontSize = 10.sp,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
        )
    }
}

@Composable
private fun OrderListBody(
    title: String,
    zone: String?,
    waiterName: String?,
    totalLabel: String,
    itemsCount: Int,
    timeLabel: String,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                title,
                fontSize = 16.sp,
                fontWeight = FontWeight.Bold,
                color = Color(0xFF2563EB),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            val sub = zone?.let { "$it · Новый заказ" } ?: "Новый заказ"
            Text(
                sub,
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            waiterName?.takeIf { it.isNotBlank() }?.let {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(
                        Icons.Outlined.Person,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f),
                        modifier = Modifier.size(12.dp),
                    )
                    Spacer(Modifier.width(4.dp))
                    Text(it, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(totalLabel, fontSize = 17.sp, fontWeight = FontWeight.Bold, maxLines = 1, softWrap = false)
            Text("$itemsCount поз.", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
            if (timeLabel.isNotBlank()) {
                Text(timeLabel, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f))
            }
        }
    }
}

@Composable
private fun OrderCompactBody(
    title: String,
    zone: String?,
    waiterName: String?,
    isBill: Boolean,
    totalLabel: String,
    guestsCount: Int,
    items: List<com.restos.waiter.data.orders.OrderItemDto>,
    timeLabel: String,
) {
    val nameColor = if (isBill) Color(0xFFEF4444) else Color(0xFF2563EB)
    val subtitle = if (isBill) "Запросили счёт" else "Новый заказ"
    val firstItems = items.take(2)

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 12.dp, vertical = 10.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.Top,
        ) {
            Text(
                title, fontSize = 15.sp, fontWeight = FontWeight.Bold, color = nameColor,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (timeLabel.isNotBlank()) {
                Text(
                    timeLabel,
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f),
                    maxLines = 1,
                    modifier = Modifier.padding(start = 6.dp),
                )
            }
        }
        Text(
            subtitle,
            fontSize = 11.sp,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )

        Spacer(Modifier.height(8.dp))
        HorizontalDivider(color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f))
        Spacer(Modifier.height(6.dp))

        Column(modifier = Modifier.weight(1f)) {
            if (firstItems.isEmpty()) {
                Text(
                    "Пусто", fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.4f),
                )
            } else {
                firstItems.forEach { item ->
                    Text(
                        "${item.qty} ${item.nameAtOrder}",
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.8f),
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                }
                if (items.size > firstItems.size) {
                    Text(
                        "…", fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.4f),
                    )
                }
            }
        }

        Spacer(Modifier.height(6.dp))
        HorizontalDivider(color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f))
        Spacer(Modifier.height(8.dp))

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    Icons.Outlined.Person,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                    modifier = Modifier.size(14.dp),
                )
                Spacer(Modifier.width(4.dp))
                Text(
                    if (guestsCount > 0) guestsCount.toString() else "—",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
                )
            }
            Text(
                totalLabel,
                fontSize = 14.sp,
                fontWeight = FontWeight.Bold,
                maxLines = 1,
                softWrap = false,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun EmptyState() {
    Column(
        modifier = Modifier.fillMaxWidth().heightIn(min = 240.dp).padding(top = 60.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(
            Icons.Outlined.Receipt,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.3f),
            modifier = Modifier.size(48.dp),
        )
        Spacer(Modifier.height(12.dp))
        Text(
            "Нет активных заказов",
            fontSize = 14.sp,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
        )
    }
}

@Composable
private fun SkeletonList() {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        repeat(3) {
            Surface(
                modifier = Modifier.fillMaxWidth().height(86.dp),
                shape = RoundedCornerShape(12.dp),
                color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
                content = {},
            )
        }
    }
}

private fun String.toBigDecimalSafe(): BigDecimal =
    runCatching { BigDecimal(this) }.getOrDefault(BigDecimal.ZERO)
