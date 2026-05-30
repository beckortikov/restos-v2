package com.restos.waiter.ui.order

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
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Block
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.Place
import androidx.compose.material.icons.outlined.Receipt
import androidx.compose.material.icons.outlined.SwapHoriz
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.restos.waiter.data.menu.MenuItemDto
import com.restos.waiter.data.orders.CancelReasons
import com.restos.waiter.data.orders.OrderDto
import com.restos.waiter.data.orders.OrderItemDto
import com.restos.waiter.data.orders.OrderStatus
import com.restos.waiter.data.tables.TableDto
import com.restos.waiter.util.formatCurrency
import com.restos.waiter.util.formatTimeSince
import java.math.BigDecimal

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OrderDetailScreen(
    onBack: () -> Unit,
    onFinished: () -> Unit,
    onAddItems: (orderId: String, tableId: String?) -> Unit,
    onNewGroup: (tableId: String) -> Unit,
    onSwitchGroup: (orderId: String) -> Unit,
    viewModel: OrderDetailViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val dialog by viewModel.dialog.collectAsStateWithLifecycle()
    val finished by viewModel.finished.collectAsStateWithLifecycle()
    val snackbarHostState = remember { SnackbarHostState() }

    LaunchedEffect(finished) {
        if (finished) {
            // Даём 3 секунды на чтение плашки «Оплачено» / «Отменён».
            kotlinx.coroutines.delay(3_000)
            onFinished()
        }
    }

    LaunchedEffect(state.toast, state.error) {
        state.toast?.let {
            snackbarHostState.showSnackbar(it)
            viewModel.consumeToast()
        }
        state.error?.let {
            snackbarHostState.showSnackbar(it)
            viewModel.consumeToast()
        }
    }

    Scaffold(
        topBar = {
            CenterAlignedTopAppBar(
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Назад")
                    }
                },
                title = { OrderTitle(state.order) },
                actions = {
                    if (state.order?.let { OrderStatus.isFresh(it.status) } == true &&
                        state.order?.table != null
                    ) {
                        IconButton(onClick = viewModel::openTransferTable) {
                            Icon(
                                Icons.Outlined.Place,
                                contentDescription = "Перенести на другой стол",
                            )
                        }
                    }
                },
            )
        },
        bottomBar = {
            val o = state.order
            when {
                o == null -> Unit
                OrderStatus.isFresh(o.status) -> BottomActions(
                    order = o,
                    busy = state.busy,
                    onPrintPreBill = viewModel::printPreBill,
                    onAddItems = {
                        state.order?.let { ord -> onAddItems(ord.id, ord.table) }
                    },
                    onCancelOrder = viewModel::openCancelOrder,
                    onAssignWaiter = viewModel::openAssignWaiter,
                )
                o.status == OrderStatus.BILL_REQUESTED ->
                    BillRequestedBanner()
                o.status == OrderStatus.DONE -> FinishedBanner("Заказ оплачен", success = true)
                o.status == OrderStatus.CANCELLED -> FinishedBanner("Заказ отменён", success = false)
            }
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
        containerColor = MaterialTheme.colorScheme.background,
    ) { inner ->
        Box(Modifier.fillMaxSize().padding(inner)) {
            when {
                state.order == null && !state.loading -> Box(
                    Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        state.error ?: "Заказ не найден",
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                    )
                }

                state.order == null -> Box(Modifier.fillMaxSize())
                else -> OrderBody(
                    state = state,
                    onAddItem = viewModel::addItem,
                    onSearch = viewModel::setSearch,
                    onCancelItem = viewModel::openCancelItem,
                    onToggleServed = viewModel::toggleServed,
                    onEditNote = viewModel::openEditNote,
                    onSwitchGroup = onSwitchGroup,
                    onNewGroup = {
                        state.order?.table?.let { tableId -> onNewGroup(tableId) }
                    },
                )
            }
        }
    }

    when (val d = dialog) {
        OrderDetailDialog.None -> Unit
        is OrderDetailDialog.CancelItem -> CancelReasonDialog(
            title = "Отмена: ${d.item.nameAtOrder}",
            reasons = state.itemReasons,
            busy = state.busy,
            onDismiss = viewModel::dismissDialog,
            onPick = { reason -> viewModel.cancelItem(d.item, reason) },
        )
        OrderDetailDialog.CancelOrder -> CancelReasonDialog(
            title = "Отменить заказ?",
            reasons = state.orderReasons,
            busy = state.busy,
            onDismiss = viewModel::dismissDialog,
            onPick = viewModel::cancelOrder,
        )
        OrderDetailDialog.TransferTable -> TransferTableDialog(
            tables = state.tables,
            currentTableId = state.order?.table,
            busy = state.busy,
            onDismiss = viewModel::dismissDialog,
            onPick = viewModel::transferTo,
        )
        is OrderDetailDialog.EditNote -> EditNoteDialog(
            item = d.item,
            busy = state.busy,
            onDismiss = viewModel::dismissDialog,
            onSave = { note -> viewModel.saveItemNote(d.item, note) },
        )
        OrderDetailDialog.AssignWaiter -> AssignWaiterDialog(
            waiters = state.waiters,
            currentWaiterId = state.order?.waiter,
            busy = state.busy,
            onDismiss = viewModel::dismissDialog,
            onPick = viewModel::assignWaiterTo,
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun EditNoteDialog(
    item: OrderItemDto,
    busy: Boolean,
    onDismiss: () -> Unit,
    onSave: (String) -> Unit,
) {
    val noteState = remember(item.id) {
        androidx.compose.runtime.mutableStateOf(
            androidx.compose.ui.text.input.TextFieldValue(item.note),
        )
    }
    val presets = listOf(
        "Без лука", "Без соли", "Хорошо прожарить", "На вынос",
        "Острое", "Без перца",
    )
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Комментарий к «${item.nameAtOrder}»", fontWeight = FontWeight.SemiBold) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = noteState.value,
                    onValueChange = { noteState.value = it },
                    placeholder = { Text("Например: без лука") },
                    singleLine = false,
                    minLines = 2,
                    enabled = !busy,
                    modifier = Modifier.fillMaxWidth(),
                )
                Text(
                    "Часто",
                    fontSize = 11.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f),
                )
                androidx.compose.foundation.lazy.LazyRow(
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    items(presets) { preset ->
                        Surface(
                            color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
                            shape = RoundedCornerShape(50),
                            onClick = {
                                noteState.value =
                                    androidx.compose.ui.text.input.TextFieldValue(preset)
                            },
                        ) {
                            Text(
                                preset,
                                fontSize = 12.sp,
                                modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
                            )
                        }
                    }
                }
            }
        },
        confirmButton = {
            Button(
                onClick = { onSave(noteState.value.text) },
                enabled = !busy,
            ) { Text("Сохранить") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !busy) { Text("Отмена") }
        },
    )
}

@Composable
private fun AssignWaiterDialog(
    waiters: List<com.restos.waiter.data.auth.UserDto>,
    currentWaiterId: String?,
    busy: Boolean,
    onDismiss: () -> Unit,
    onPick: (com.restos.waiter.data.auth.UserDto) -> Unit,
) {
    val others = remember(waiters, currentWaiterId) {
        waiters.filter { it.id != currentWaiterId }
            .sortedBy { it.displayName.lowercase() }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Передать стол", fontWeight = FontWeight.SemiBold) },
        text = {
            if (others.isEmpty()) {
                Text(
                    "Нет других официантов",
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                )
            } else {
                LazyColumn(
                    modifier = Modifier.height(320.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    items(others, key = { it.id }) { u ->
                        OutlinedButton(
                            onClick = { onPick(u) },
                            enabled = !busy,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text(
                                u.displayName,
                                modifier = Modifier.weight(1f),
                                textAlign = androidx.compose.ui.text.style.TextAlign.Start,
                            )
                        }
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !busy) { Text("Отмена") }
        },
    )
}

@Composable
private fun OrderTitle(order: OrderDto?) {
    if (order == null) {
        Text("Заказ", fontWeight = FontWeight.SemiBold)
        return
    }
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        val title = order.tableName
            ?: order.orderNumber?.let { "Заказ №$it" }
            ?: "Заказ"
        Text(
            title,
            fontWeight = FontWeight.SemiBold,
            fontSize = 16.sp,
        )
        val subtitle = listOfNotNull(order.tableZoneName, order.statusDisplay)
            .joinToString(" · ")
        if (subtitle.isNotBlank()) {
            Text(
                subtitle,
                fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f),
            )
        }
    }
}

@Composable
private fun OrderBody(
    state: OrderDetailUiState,
    onAddItem: (MenuItemDto) -> Unit,
    onSearch: (String) -> Unit,
    onCancelItem: (OrderItemDto) -> Unit,
    onToggleServed: (OrderItemDto) -> Unit,
    onEditNote: (OrderItemDto) -> Unit,
    onSwitchGroup: (String) -> Unit,
    onNewGroup: () -> Unit,
) {
    val order = state.order!!
    val items = order.items.filter { it.cancelledAt == null }
    val searchResults = remember(state.search, state.menu) {
        val q = state.search.trim().lowercase()
        if (q.isBlank()) emptyList()
        else state.menu
            .filter { it.isAvailable && it.name.lowercase().contains(q) }
            .take(8)
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (state.groups.size > 1 || order.table != null) {
            item {
                GroupsRow(
                    groups = state.groups,
                    activeId = order.id,
                    onSwitch = onSwitchGroup,
                    onNewGroup = onNewGroup,
                    showNewGroupButton = order.table != null,
                )
            }
        }
        // OrderHeaderCard убран — те же поля (имя стола / зона / статус /
        // время / гости / официант) есть в TopAppBar и в chips групп.
        item { Spacer(Modifier.height(4.dp)) }
        if (OrderStatus.isFresh(order.status)) {
            item {
                AddItemSearch(
                    query = state.search,
                    results = searchResults,
                    busy = state.busy,
                    onQuery = onSearch,
                    onPick = onAddItem,
                )
            }
            item { Spacer(Modifier.height(4.dp)) }
        }
        if (items.isEmpty()) {
            item {
                Text(
                    "Нет активных позиций",
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                    modifier = Modifier.padding(vertical = 12.dp),
                )
            }
        } else {
            items(items, key = { it.id }) { it ->
                if (OrderStatus.isFresh(order.status)) {
                    SwipeableOrderLine(
                        item = it,
                        onCancel = { onCancelItem(it) },
                        onEditNote = { onEditNote(it) },
                        onToggleServed = { onToggleServed(it) },
                    )
                } else {
                    OrderLineCard(
                        item = it,
                        canCancel = false,
                        canToggleServed = order.status == OrderStatus.BILL_REQUESTED,
                        onCancel = {},
                        onToggleServed = { onToggleServed(it) },
                    )
                }
            }
        }
        item { Spacer(Modifier.height(4.dp)) }
        item { TotalsBlock(order) }
        if (order.cancelledItems.isNotEmpty()) {
            item { Spacer(Modifier.height(8.dp)) }
            item { CancelledItemsSection(order.cancelledItems) }
        }
        item { Spacer(Modifier.height(72.dp)) } // под BottomActions
    }
}

@Composable
private fun GroupsRow(
    groups: List<OrderDto>,
    activeId: String,
    onSwitch: (String) -> Unit,
    onNewGroup: () -> Unit,
    showNewGroupButton: Boolean,
) {
    androidx.compose.foundation.lazy.LazyRow(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        itemsIndexed(groups, key = { _, g -> g.id }) { i, g ->
            val active = g.id == activeId
            Surface(
                shape = RoundedCornerShape(50),
                color = if (active) MaterialTheme.colorScheme.primary
                else MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
                onClick = { if (!active) onSwitch(g.id) },
            ) {
                Text(
                    "Группа ${i + 1}",
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = if (active) MaterialTheme.colorScheme.onPrimary
                    else MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
                )
            }
        }
        if (showNewGroupButton) {
            item {
                Surface(
                    shape = RoundedCornerShape(50),
                    color = MaterialTheme.colorScheme.surface,
                    border = androidx.compose.foundation.BorderStroke(
                        1.dp, MaterialTheme.colorScheme.primary,
                    ),
                    onClick = onNewGroup,
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                    ) {
                        Icon(
                            Icons.Outlined.Add,
                            contentDescription = null,
                            modifier = Modifier.size(16.dp),
                            tint = MaterialTheme.colorScheme.primary,
                        )
                        Spacer(Modifier.width(4.dp))
                        Text(
                            "Группа",
                            fontSize = 13.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = MaterialTheme.colorScheme.primary,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun OrderHeaderCard(order: OrderDto) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(12.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Column {
                Text(
                    order.tableName ?: "—",
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 16.sp,
                )
                order.tableZoneName?.let {
                    Text(it, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
                }
                order.waiterName?.takeIf { it.isNotBlank() }?.let { name ->
                    Text(
                        name,
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                        modifier = Modifier.padding(top = 4.dp),
                    )
                }
            }
            Column(horizontalAlignment = Alignment.End) {
                StatusBadge(status = order.status, label = order.statusDisplay ?: order.status)
                Text(
                    formatTimeSince(java.time.Instant.parse(order.createdAt).toEpochMilli()),
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f),
                    modifier = Modifier.padding(top = 4.dp),
                )
                if (order.guestsCount > 0) {
                    Text(
                        "${order.guestsCount} гостей",
                        fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f),
                    )
                }
            }
        }
    }
}

@Composable
private fun StatusBadge(status: String, label: String) {
    val (bg, fg) = when (status) {
        OrderStatus.BILL_REQUESTED -> Color(0xFF8B5CF6) to Color.White
        OrderStatus.DONE -> Color(0xFF10B981) to Color.White
        OrderStatus.CANCELLED -> Color(0xFFE5E7EB) to Color(0xFF6B7280)
        else -> Color(0xFFDBEAFE) to Color(0xFF1D4ED8)
    }
    Surface(color = bg, shape = RoundedCornerShape(50)) {
        Text(
            label.uppercase(),
            color = fg,
            fontSize = 10.sp,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AddItemSearch(
    query: String,
    results: List<MenuItemDto>,
    busy: Boolean,
    onQuery: (String) -> Unit,
    onPick: (MenuItemDto) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        TextField(
            value = query,
            onValueChange = onQuery,
            placeholder = { Text("Поиск блюда для дозаказа...") },
            leadingIcon = { Icon(Icons.Outlined.Search, contentDescription = null) },
            trailingIcon = if (query.isNotEmpty()) {
                @Composable {
                    IconButton(onClick = { onQuery("") }) {
                        Icon(Icons.Outlined.Close, contentDescription = null)
                    }
                }
            } else null,
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            colors = TextFieldDefaults.colors(
                focusedContainerColor = MaterialTheme.colorScheme.surface,
                unfocusedContainerColor = MaterialTheme.colorScheme.surface,
                focusedIndicatorColor = Color.Transparent,
                unfocusedIndicatorColor = Color.Transparent,
            ),
            shape = RoundedCornerShape(12.dp),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            enabled = !busy,
        )
        if (results.isNotEmpty()) {
            Surface(
                shape = RoundedCornerShape(12.dp),
                color = MaterialTheme.colorScheme.surface,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column {
                    results.forEach { m ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(0.dp))
                                .background(Color.Transparent),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            TextButton(
                                onClick = { onPick(m) },
                                enabled = !busy,
                                modifier = Modifier.fillMaxWidth(),
                                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
                            ) {
                                Text(
                                    m.name,
                                    modifier = Modifier.weight(1f),
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    color = MaterialTheme.colorScheme.onSurface,
                                )
                                Spacer(Modifier.width(12.dp))
                                Text(
                                    formatCurrency(m.price.toBigDecimalSafe()),
                                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
                                    fontSize = 13.sp,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SwipeableOrderLine(
    item: OrderItemDto,
    onCancel: () -> Unit,
    onEditNote: () -> Unit,
    onToggleServed: () -> Unit,
) {
    val dismissState = androidx.compose.material3.rememberSwipeToDismissBoxState(
        positionalThreshold = { distance -> distance * 0.35f },
        confirmValueChange = { value ->
            when (value) {
                androidx.compose.material3.SwipeToDismissBoxValue.EndToStart -> {
                    onCancel()
                    false  // не уничтожаем — диалог сам решает
                }
                androidx.compose.material3.SwipeToDismissBoxValue.StartToEnd -> {
                    onEditNote()
                    false
                }
                else -> false
            }
        },
    )
    androidx.compose.material3.SwipeToDismissBox(
        state = dismissState,
        backgroundContent = {
            val dir = dismissState.dismissDirection
            val bg = when (dir) {
                androidx.compose.material3.SwipeToDismissBoxValue.EndToStart -> Color(0xFFFEE2E2)
                androidx.compose.material3.SwipeToDismissBoxValue.StartToEnd -> Color(0xFFDBEAFE)
                else -> Color.Transparent
            }
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(bg, RoundedCornerShape(12.dp))
                    .padding(horizontal = 16.dp),
                contentAlignment = when (dir) {
                    androidx.compose.material3.SwipeToDismissBoxValue.EndToStart ->
                        Alignment.CenterEnd
                    androidx.compose.material3.SwipeToDismissBoxValue.StartToEnd ->
                        Alignment.CenterStart
                    else -> Alignment.Center
                },
            ) {
                when (dir) {
                    androidx.compose.material3.SwipeToDismissBoxValue.EndToStart -> Row(
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(
                            Icons.Outlined.Close,
                            contentDescription = null,
                            tint = Color(0xFFBE123C),
                        )
                        Spacer(Modifier.width(6.dp))
                        Text(
                            "Отменить",
                            color = Color(0xFFBE123C),
                            fontWeight = FontWeight.SemiBold,
                        )
                    }
                    androidx.compose.material3.SwipeToDismissBoxValue.StartToEnd -> Row(
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(
                            Icons.Outlined.Edit,
                            contentDescription = null,
                            tint = Color(0xFF1D4ED8),
                        )
                        Spacer(Modifier.width(6.dp))
                        Text(
                            "Комментарий",
                            color = Color(0xFF1D4ED8),
                            fontWeight = FontWeight.SemiBold,
                        )
                    }
                    else -> {}
                }
            }
        },
        content = {
            OrderLineCard(
                item = item,
                canCancel = false,
                canToggleServed = true,
                onCancel = {},
                onToggleServed = onToggleServed,
            )
        },
    )
}

@Composable
private fun OrderLineCard(
    item: OrderItemDto,
    canCancel: Boolean,
    canToggleServed: Boolean,
    onCancel: () -> Unit,
    onToggleServed: () -> Unit,
) {
    val served = item.servedAt != null || item.kitchenStatus == "served"
    // Тап по карточке = переключить «подано» (без отдельного чекбокса).
    val bg = if (served) Color(0xFF064E3B).copy(alpha = 0.20f)
    else MaterialTheme.colorScheme.surface
    val borderColor = if (served) Color(0xFF10B981).copy(alpha = 0.6f)
    else MaterialTheme.colorScheme.surfaceVariant
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .border(1.dp, borderColor, RoundedCornerShape(10.dp)),
        shape = RoundedCornerShape(10.dp),
        color = bg,
        onClick = onToggleServed,
        enabled = canToggleServed,
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    item.nameAtOrder,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    color = if (served) MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f)
                    else MaterialTheme.colorScheme.onSurface,
                    textDecoration = if (served)
                        androidx.compose.ui.text.style.TextDecoration.LineThrough
                    else null,
                )
                if (item.note.isNotBlank()) {
                    Text(
                        "! ${item.note}",
                        fontSize = 11.sp,
                        fontStyle = androidx.compose.ui.text.font.FontStyle.Italic,
                        color = Color(0xFFB45309),
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                // Kitchen-status бейджи убраны по запросу — официанту лишний
                // визуальный шум. Зачёркивание+ослабленный цвет на «served»
                // через `served` уже даёт нужный сигнал.
                Text(
                    "${item.qty} × ${formatCurrency(item.priceAtOrder.toBigDecimalSafe())}",
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = if (served) 0.45f else 0.6f),
                    textDecoration = if (served)
                        androidx.compose.ui.text.style.TextDecoration.LineThrough
                    else null,
                )
            }
            // Комментарий (если есть) — справа, маленьким курсивом-серым.
            if (item.note.isNotBlank()) {
                Text(
                    "💬",
                    fontSize = 13.sp,
                    modifier = Modifier.padding(end = 4.dp),
                )
            }
            Text(
                formatCurrency(item.subtotal.toBigDecimalSafe()),
                fontSize = 14.sp,
                fontWeight = FontWeight.Bold,
                maxLines = 1,
                softWrap = false,
            )
        }
    }
}

@Composable
private fun ServedCheckbox(checked: Boolean, onClick: () -> Unit) {
    Surface(
        modifier = Modifier.size(28.dp),
        shape = RoundedCornerShape(6.dp),
        color = if (checked) Color(0xFF10B981) else MaterialTheme.colorScheme.surfaceVariant,
        border = androidx.compose.foundation.BorderStroke(
            1.dp,
            if (checked) Color(0xFF10B981)
            else MaterialTheme.colorScheme.outline.copy(alpha = 0.4f),
        ),
        onClick = onClick,
    ) {
        if (checked) {
            Box(contentAlignment = Alignment.Center, modifier = Modifier.fillMaxSize()) {
                Icon(
                    Icons.Outlined.Check,
                    contentDescription = "Подано",
                    tint = Color.White,
                    modifier = Modifier.size(18.dp),
                )
            }
        }
    }
}

@Composable
private fun TotalsBlock(order: OrderDto) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
    ) {
        Column(modifier = Modifier.padding(12.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text("Подытог", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.65f))
                Text(formatCurrency(order.subtotal.toBigDecimalSafe()), fontSize = 13.sp)
            }
            if (order.serviceChargeAmount.toBigDecimalSafe() > BigDecimal.ZERO) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text(
                        "Обслуживание",
                        fontSize = 13.sp,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.65f),
                    )
                    Text(formatCurrency(order.serviceChargeAmount.toBigDecimalSafe()), fontSize = 13.sp)
                }
            }
            if (order.discountAmount.toBigDecimalSafe() > BigDecimal.ZERO) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text(
                        "Скидка",
                        fontSize = 13.sp,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.65f),
                    )
                    Text(
                        "-${formatCurrency(order.discountAmount.toBigDecimalSafe())}",
                        fontSize = 13.sp,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }
            Spacer(Modifier.height(6.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text("Итого", fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
                Text(
                    formatCurrency(order.total.toBigDecimalSafe()),
                    fontWeight = FontWeight.Bold,
                    fontSize = 16.sp,
                )
            }
        }
    }
}

@Composable
private fun BottomActions(
    order: OrderDto,
    busy: Boolean,
    onPrintPreBill: () -> Unit,
    onAddItems: () -> Unit,
    onCancelOrder: () -> Unit,
    onAssignWaiter: () -> Unit,
) {
    Surface(color = MaterialTheme.colorScheme.surface, shadowElevation = 8.dp) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(horizontal = 12.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            // 1) Печать пре-чека — голубая outlined-кнопка во всю ширину
            OutlinedButton(
                onClick = onPrintPreBill,
                enabled = !busy && OrderStatus.isFresh(order.status),
                modifier = Modifier.fillMaxWidth().height(48.dp),
                colors = ButtonDefaults.outlinedButtonColors(
                    contentColor = Color(0xFF1D4ED8),
                ),
                border = androidx.compose.foundation.BorderStroke(
                    1.dp, Color(0xFFBFDBFE),
                ),
            ) {
                Icon(Icons.Outlined.Receipt, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text("Печать пре-чека", fontWeight = FontWeight.SemiBold)
            }
            // 2) «+ Добавить» (filled) во всю ширину
            Button(
                onClick = onAddItems,
                enabled = !busy && OrderStatus.isFresh(order.status),
                modifier = Modifier.fillMaxWidth().height(48.dp),
            ) {
                Icon(Icons.Outlined.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text("Добавить", fontWeight = FontWeight.SemiBold)
            }
            // 3) Передать другому официанту — всегда видимая. Если других нет —
            //    диалог сам скажет «нет других официантов».
            Button(
                onClick = onAssignWaiter,
                enabled = !busy && OrderStatus.isFresh(order.status),
                modifier = Modifier.fillMaxWidth().height(48.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = Color(0xFFFEF3C7),
                    contentColor = Color(0xFF92400E),
                ),
            ) {
                Icon(Icons.Outlined.SwapHoriz, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text("Передать другому официанту", fontWeight = FontWeight.SemiBold)
            }
            // 4) Отменить заказ — красная outlined (вертикально внизу)
            OutlinedButton(
                onClick = onCancelOrder,
                enabled = !busy && OrderStatus.isFresh(order.status),
                modifier = Modifier.fillMaxWidth().height(48.dp),
                colors = ButtonDefaults.outlinedButtonColors(
                    contentColor = MaterialTheme.colorScheme.error,
                ),
                border = androidx.compose.foundation.BorderStroke(
                    1.dp, MaterialTheme.colorScheme.error.copy(alpha = 0.4f),
                ),
            ) {
                Icon(Icons.Outlined.Block, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text("Отменить заказ", fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

@Composable
private fun CancelledItemsSection(
    items: List<com.restos.waiter.data.orders.CancelledItemDto>,
) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        color = MaterialTheme.colorScheme.surface,
    ) {
        Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    Icons.Outlined.Block,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.error,
                    modifier = Modifier.size(16.dp),
                )
                Spacer(Modifier.width(6.dp))
                Text(
                    "История отмен",
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                Spacer(Modifier.weight(1f))
                Text(
                    "${items.size}",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                )
            }
            items.forEach { it -> CancelledItemRow(it) }
        }
    }
}

@Composable
private fun CancelledItemRow(item: com.restos.waiter.data.orders.CancelledItemDto) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.Top,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                item.nameAtOrder,
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
                textDecoration = androidx.compose.ui.text.style.TextDecoration.LineThrough,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
            )
            val reason = item.cancelReason.ifBlank { "—" }
            Text(
                "Причина: $reason",
                fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
            )
            val by = item.cancelledByName?.takeIf { it.isNotBlank() } ?: "неизвестно"
            val time = item.cancelledAt?.let {
                runCatching { com.restos.waiter.util.formatTimeSince(java.time.Instant.parse(it).toEpochMilli()) }
                    .getOrNull()
            }
            Text(
                "Отменил: $by${time?.let { " · $it назад" } ?: ""}",
                fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f),
            )
        }
        Column(horizontalAlignment = Alignment.End) {
            Text(
                "${item.qty} ×",
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
            )
            Text(
                formatCurrency(item.priceAtOrder.toBigDecimalSafe()),
                fontSize = 12.sp,
                fontWeight = FontWeight.Medium,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
            )
        }
    }
}

@Composable
private fun BillRequestedBanner() {
    Surface(color = Color(0xFF8B5CF6), shadowElevation = 8.dp) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(horizontal = 12.dp, vertical = 16.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                "Кассир принимает оплату",
                color = Color.White,
                fontWeight = FontWeight.SemiBold,
                fontSize = 15.sp,
            )
        }
    }
}

@Composable
private fun FinishedBanner(text: String, success: Boolean) {
    val bg = if (success) Color(0xFF10B981) else Color(0xFF6B7280)
    Surface(color = bg, shadowElevation = 8.dp) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(horizontal = 12.dp, vertical = 14.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(text, color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
            Text(
                "Возвращаемся к столам…",
                color = Color.White.copy(alpha = 0.85f),
                fontSize = 12.sp,
            )
        }
    }
}

@Composable
private fun CancelReasonDialog(
    title: String,
    reasons: List<CancelReasons.Reason>,
    busy: Boolean,
    onDismiss: () -> Unit,
    onPick: (String) -> Unit,
) {
    val fallback = remember(reasons) {
        if (reasons.isNotEmpty()) reasons.map { it.label }
        else listOf("По просьбе клиента", "Кухня отменила", "Ошибка официанта", "Нет ингредиента")
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title, fontWeight = FontWeight.SemiBold) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                fallback.forEach { label ->
                    OutlinedButton(
                        onClick = { onPick(label) },
                        enabled = !busy,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(label, modifier = Modifier.fillMaxWidth())
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !busy) { Text("Отмена") }
        },
    )
}

@Composable
private fun TransferTableDialog(
    tables: List<TableDto>,
    currentTableId: String?,
    busy: Boolean,
    onDismiss: () -> Unit,
    onPick: (TableDto) -> Unit,
) {
    val freeTables = remember(tables, currentTableId) {
        tables
            .filter { it.id != currentTableId && it.status == "free" }
            .sortedWith(compareBy({ it.number }, { it.name }))
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Перенести на стол", fontWeight = FontWeight.SemiBold) },
        text = {
            if (freeTables.isEmpty()) {
                Text("Нет свободных столов", color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
            } else {
                LazyColumn(
                    modifier = Modifier.height(360.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    items(freeTables, key = { it.id }) { t ->
                        OutlinedButton(
                            onClick = { onPick(t) },
                            enabled = !busy,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text(
                                t.name.ifBlank { t.number.toString() },
                                modifier = Modifier.weight(1f),
                                textAlign = androidx.compose.ui.text.style.TextAlign.Start,
                            )
                            t.zoneName?.let {
                                Text(
                                    it,
                                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                                    fontSize = 12.sp,
                                )
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !busy) { Text("Отмена") }
        },
    )
}

private fun String.toBigDecimalSafe(): BigDecimal =
    runCatching { BigDecimal(this) }.getOrDefault(BigDecimal.ZERO)
