package com.restos.waiter.ui.tables

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Assignment
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
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
import com.restos.waiter.data.preferences.TablesTab
import com.restos.waiter.data.preferences.ViewMode
import com.restos.waiter.data.tables.TableCardSnapshot
import com.restos.waiter.util.formatCurrency
import com.restos.waiter.util.formatTimeSince

@Composable
fun TablesScreen(
    onOpenOrder: (orderId: String) -> Unit,
    onResumeDraft: (tableId: String) -> Unit,
    onSelectTableForNew: () -> Unit,
    viewModel: TablesViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val viewMode by viewModel.viewMode.collectAsStateWithLifecycle()
    val cards = remember(state.cards, state.tab, viewModel.myUserId) {
        filterCards(state.cards, state.tab, viewModel.myUserId)
    }

    // Когда экран возвращается на передний план (например, после создания
    // заказа и navigate back) — сразу запрашиваем актуальные данные.
    val lifecycleOwner = androidx.lifecycle.compose.LocalLifecycleOwner.current
    androidx.compose.runtime.DisposableEffect(lifecycleOwner) {
        val observer = androidx.lifecycle.LifecycleEventObserver { _, event ->
            if (event == androidx.lifecycle.Lifecycle.Event.ON_RESUME) {
                viewModel.refresh()
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    Scaffold(
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = onSelectTableForNew,
                containerColor = MaterialTheme.colorScheme.primary,
                contentColor = MaterialTheme.colorScheme.onPrimary,
                icon = { Icon(Icons.Outlined.Add, contentDescription = null) },
                text = { Text("Новый заказ", fontWeight = FontWeight.Medium) },
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { inner ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(inner),
        ) {
            // Табы — сразу под шапкой, без верхнего отступа.
            TabsRow(
                state.tab,
                onSelect = viewModel::setTab,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
            )

            Column(modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp)) {
                when {
                    state.loading && cards.isEmpty() -> SkeletonList()
                    cards.isEmpty() -> EmptyState()
                    viewMode == ViewMode.Grid -> CardsGrid(cards) { card ->
                        onCardTap(card, onOpenOrder, onResumeDraft)
                    }
                    else -> CardsList(cards) { card ->
                        onCardTap(card, onOpenOrder, onResumeDraft)
                    }
                }
            }
        }
    }
}

private fun filterCards(
    cards: List<TableCardSnapshot>,
    tab: TablesTab,
    myUserId: String?,
): List<TableCardSnapshot> {
    if (tab == TablesTab.All || myUserId == null) return cards
    return cards.filter { card ->
        (card.draft != null && card.draft.waiterId == myUserId) ||
            card.orders.any { it.waiter == myUserId }
    }
}

private fun onCardTap(
    card: TableCardSnapshot,
    onOpenOrder: (String) -> Unit,
    onResumeDraft: (String) -> Unit,
) {
    when {
        card.isDraftOnly -> onResumeDraft(card.table.id)
        card.orders.isNotEmpty() -> onOpenOrder(card.orders.first().id)
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
        TabButton("Мои столы", active == TablesTab.Mine, Modifier.weight(1f)) {
            onSelect(TablesTab.Mine)
        }
        TabButton("Все столы", active == TablesTab.All, Modifier.weight(1f)) {
            onSelect(TablesTab.All)
        }
    }
}

@Composable
private fun TabButton(
    label: String,
    active: Boolean,
    modifier: Modifier,
    onClick: () -> Unit,
) {
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
private fun CardsList(
    cards: List<TableCardSnapshot>,
    onClick: (TableCardSnapshot) -> Unit,
) {
    LazyColumn(
        verticalArrangement = Arrangement.spacedBy(12.dp),
        contentPadding = PaddingValues(bottom = 96.dp),
    ) {
        items(cards, key = { it.table.id }) { card ->
            TableCard(card, compact = false) { onClick(card) }
        }
    }
}

@Composable
private fun CardsGrid(
    cards: List<TableCardSnapshot>,
    onClick: (TableCardSnapshot) -> Unit,
) {
    LazyVerticalGrid(
        columns = GridCells.Fixed(2),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        contentPadding = PaddingValues(bottom = 96.dp),
    ) {
        items(cards, key = { it.table.id }) { card ->
            TableCard(card, compact = true) { onClick(card) }
        }
    }
}

@Composable
private fun TableCard(
    card: TableCardSnapshot,
    compact: Boolean,
    onClick: () -> Unit,
) {
    val ringColor = when {
        card.hasBillRequested -> Color(0xFF8B5CF6)
        card.hasReady -> Color(0xFFFBBF24)
        else -> Color.Transparent
    }
    val borderColor = when {
        card.hasBillRequested -> Color(0xFFDDD6FE)
        card.hasReady -> Color(0xFFFDE68A)
        else -> MaterialTheme.colorScheme.surfaceVariant
    }

    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .let { mod ->
                if (compact) mod.height(155.dp) else mod
            }
            .let { if (ringColor != Color.Transparent) it.border(2.dp, ringColor, RoundedCornerShape(12.dp)) else it }
            .border(1.dp, borderColor, RoundedCornerShape(12.dp)),
        shape = RoundedCornerShape(12.dp),
        color = MaterialTheme.colorScheme.surface,
        onClick = onClick,
    ) {
        if (compact) CardCompactBody(card) else CardListBody(card)
    }
}

@Composable
private fun StatusPill(billRequested: Boolean, modifier: Modifier = Modifier) {
    val bg = if (billRequested) Color(0xFF8B5CF6) else Color(0xFFFBBF24)
    val fg = if (billRequested) Color.White else Color(0xFF78350F)
    Surface(
        modifier = modifier,
        color = bg,
        shape = RoundedCornerShape(50),
    ) {
        Text(
            text = if (billRequested) "СЧЁТ" else "ГОТОВ",
            color = fg,
            fontSize = 10.sp,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
        )
    }
}

@Composable
private fun CardListBody(card: TableCardSnapshot) {
    // iiko-style горизонтальная карточка: цветное имя | мета | сумма+поз.
    val nameColor = when {
        card.hasBillRequested -> Color(0xFFEF4444)
        card.hasReady -> Color(0xFF10B981)
        card.isDraftOnly -> Color(0xFFD97706)
        else -> Color(0xFF2563EB)
    }
    val statusLabel = when {
        card.hasBillRequested -> "Запросили счёт"
        card.hasReady -> "Блюда готовы"
        card.isDraftOnly -> "Черновик"
        else -> "Новый заказ"
    }
    val zoneText = card.zone?.name?.let { "$it · $statusLabel" } ?: statusLabel

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Левая колонка: имя + zone+статус + официант
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                card.table.name,
                fontSize = 16.sp,
                fontWeight = FontWeight.Bold,
                color = nameColor,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                zoneText,
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (!card.isDraftOnly) {
                card.waiter?.let { user ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            Icons.Outlined.Person,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f),
                            modifier = Modifier.size(12.dp),
                        )
                        Spacer(Modifier.width(4.dp))
                        Text(
                            user.displayName,
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }
        // Правая колонка: сумма (крупно) + N поз. + время
        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                formatCurrency(card.totalOpen),
                fontSize = 17.sp,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                softWrap = false,
            )
            val groupsLabel = if (!card.isDraftOnly && card.orders.size > 1)
                "${card.orders.size} гр. · " else ""
            Text(
                "$groupsLabel${card.itemsCount} поз.",
                fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                maxLines = 1,
            )
            card.oldestEpochMillis?.let { ts ->
                Text(
                    formatTimeSince(ts),
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f),
                    maxLines = 1,
                )
            }
        }
    }
}

@Composable
private fun CardCompactBody(card: TableCardSnapshot) {
    // iiko-style: имя стола слева цветом по статусу, время справа.
    // В теле — список первых 3 позиций. Внизу — гости + сумма.
    val nameColor = when {
        card.hasBillRequested -> Color(0xFFEF4444)
        card.hasReady -> Color(0xFF10B981)
        card.isDraftOnly -> Color(0xFFD97706)
        else -> Color(0xFF2563EB)
    }
    val subtitle = when {
        card.hasBillRequested -> "Запросили счёт"
        card.hasReady -> "Блюда готовы"
        card.isDraftOnly -> "Черновик"
        else -> "Новый заказ"
    }
    // Собираем первые 3 позиции из всех активных заказов на этом столе.
    val firstItems = card.orders
        .flatMap { it.items }
        .filter { it.cancelledAt == null }
        .take(2)
    val totalGuests = card.orders.sumOf { it.guestsCount }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 12.dp, vertical = 10.dp),
    ) {
        // Шапка
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.Top,
        ) {
            Text(
                card.table.name,
                fontSize = 15.sp,
                fontWeight = FontWeight.Bold,
                color = nameColor,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            card.oldestEpochMillis?.let { ts ->
                Text(
                    formatTimeSince(ts),
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

        // Тонкий разделитель
        Spacer(Modifier.height(8.dp))
        HorizontalDivider(
            color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
        )
        Spacer(Modifier.height(6.dp))

        // Items (до 3 строк)
        Column(modifier = Modifier.weight(1f, fill = true)) {
            if (firstItems.isEmpty()) {
                Text(
                    "Пусто",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.4f),
                )
            } else {
                firstItems.forEach { item ->
                    Text(
                        "${item.qty} ${item.nameAtOrder}",
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.8f),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                if (card.itemsCount > firstItems.size) {
                    Text(
                        "…",
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.4f),
                    )
                }
            }
        }

        Spacer(Modifier.height(6.dp))
        HorizontalDivider(
            color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
        )
        Spacer(Modifier.height(8.dp))

        // Низ: гости слева — сумма справа.
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
                    if (totalGuests > 0) totalGuests.toString() else "—",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
                )
            }
            Text(
                formatCurrency(card.totalOpen),
                fontSize = 14.sp,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                softWrap = false,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun DraftChip() {
    Surface(
        color = Color(0xFFFEF3C7),
        shape = RoundedCornerShape(50),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
        ) {
            Icon(
                Icons.Outlined.Description,
                contentDescription = null,
                tint = Color(0xFF92400E),
                modifier = Modifier.size(12.dp),
            )
            Text("Черновик", color = Color(0xFF92400E), fontSize = 11.sp, fontWeight = FontWeight.Medium)
        }
    }
}

@Composable
private fun WaiterChip(name: String) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Icon(
            Icons.Outlined.Person,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f),
            modifier = Modifier.size(12.dp),
        )
        Text(
            name,
            fontSize = 12.sp,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun EmptyState() {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 240.dp)
            .padding(top = 80.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(
            Icons.Outlined.Assignment,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.3f),
            modifier = Modifier.size(48.dp),
        )
        Spacer(Modifier.height(12.dp))
        Text(
            "Нет активных столов",
            fontSize = 14.sp,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
        )
        Spacer(Modifier.height(4.dp))
        Text(
            "Откройте новый заказ кнопкой ниже",
            fontSize = 12.sp,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f),
        )
    }
}

@Composable
private fun SkeletonList() {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        repeat(3) {
            Surface(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(96.dp),
                shape = RoundedCornerShape(12.dp),
                color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
                content = {},
            )
        }
    }
}
