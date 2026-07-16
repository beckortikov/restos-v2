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
import androidx.compose.material.icons.outlined.Remove
import androidx.compose.material.icons.outlined.SwapHoriz
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
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
                    val o = state.order
                    if (o != null && OrderStatus.isFresh(o.status)) {
                        OrderOverflowMenu(
                            hasTable = o.table != null,
                            canCancel = state.canCancel,
                            busy = state.busy,
                            onPrintPreBill = viewModel::printPreBill,
                            onAssignWaiter = viewModel::openAssignWaiter,
                            onTransferTable = viewModel::openTransferTable,
                            onCancelOrder = viewModel::openCancelOrder,
                        )
                    }
                },
            )
        },
        bottomBar = {
            val o = state.order
            when {
                o == null -> Unit
                OrderStatus.isFresh(o.status) -> AddItemsBar(
                    order = o,
                    busy = state.busy,
                    onAddItems = {
                        state.order?.let { ord -> onAddItems(ord.id, ord.table) }
                    },
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
                    onCancelItem = viewModel::openCancelItem,
                    onIncrementItem = viewModel::incrementItem,
                    onDecrementItem = viewModel::decrementItem,
                    onAddPortion = viewModel::addPortion,
                    onRemovePortion = viewModel::removePortion,
                    onCancelGroup = viewModel::openCancelGroup,
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
            onPick = { reason -> viewModel.cancelItem(d.item, reason, d.groupIds) },
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
    waiters: List<com.restos.core.auth.UserDto>,
    currentWaiterId: String?,
    busy: Boolean,
    onDismiss: () -> Unit,
    onPick: (com.restos.core.auth.UserDto) -> Unit,
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

/** Строка отображения: одинаковые весовые порции слиты в одну с portions=N. */
private data class DisplayLine(val rep: OrderItemDto, val ids: List<String>, val portions: Int)

/** Группирует одинаковые весовые порции (g/kg) по блюду/весу/цене/комментарию. */
private fun groupWeightLines(items: List<OrderItemDto>): List<DisplayLine> {
    val out = ArrayList<DisplayLine>()
    val idx = HashMap<String, Int>()
    for (it in items) {
        val isWeight = it.unit == "g" || it.unit == "kg"
        if (isWeight) {
            val key = "${it.menuItem}|${it.priceAtOrder}|${it.unit}|${it.unitSize}|${it.qtyDec}|${it.note}"
            val at = idx[key]
            if (at != null) {
                val cur = out[at]
                out[at] = cur.copy(ids = cur.ids + it.id, portions = cur.portions + 1)
                continue
            }
            idx[key] = out.size
        }
        out.add(DisplayLine(rep = it, ids = listOf(it.id), portions = 1))
    }
    return out
}

/** «100г» / «1,5кг» из decimal-строки веса. */
private fun formatOrderWeight(qtyDec: String, unit: String?): String {
    val q = runCatching { java.math.BigDecimal(qtyDec) }.getOrDefault(java.math.BigDecimal.ZERO)
    return when (unit) {
        "g" -> q.setScale(0, java.math.RoundingMode.HALF_UP).toPlainString() + "г"
        "kg" -> q.stripTrailingZeros().toPlainString().replace(".", ",") + "кг"
        else -> q.stripTrailingZeros().toPlainString()
    }
}

@Composable
private fun OrderBody(
    state: OrderDetailUiState,
    onCancelItem: (OrderItemDto) -> Unit,
    onToggleServed: (OrderItemDto) -> Unit,
    onEditNote: (OrderItemDto) -> Unit,
    onIncrementItem: (OrderItemDto) -> Unit,
    onDecrementItem: (OrderItemDto) -> Unit,
    onAddPortion: (OrderItemDto) -> Unit,
    onRemovePortion: (String) -> Unit,
    onCancelGroup: (OrderItemDto, List<String>) -> Unit,
    onSwitchGroup: (String) -> Unit,
    onNewGroup: () -> Unit,
) {
    val order = state.order!!
    val items = order.items.filter { it.cancelledAt == null }
    // Группируем одинаковые весовые порции в строку «100г × N».
    val displayLines = remember(items) { groupWeightLines(items) }

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
        // Инлайн-поиск/категории дозаказа убраны: блюда добавляются только
        // кнопкой «Добавить» внизу (item 5) → экран нового заказа с превью.
        item { Spacer(Modifier.height(4.dp)) }
        if (items.isEmpty()) {
            item {
                Text(
                    "Нет активных позиций",
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                    modifier = Modifier.padding(vertical = 12.dp),
                )
            }
        } else {
            items(displayLines, key = { it.rep.id }) { line ->
                val rep = line.rep
                val isWeight = rep.unit == "g" || rep.unit == "kg"
                val isGroup = line.portions > 1
                if (OrderStatus.isFresh(order.status)) {
                    SwipeableOrderLine(
                        item = rep,
                        portions = line.portions,
                        canVoid = state.canVoid,
                        onCancel = { if (isGroup) onCancelGroup(rep, line.ids) else onCancelItem(rep) },
                        onEditNote = { onEditNote(rep) },
                        onToggleServed = { onToggleServed(rep) },
                        onIncrement = { if (isWeight) onAddPortion(rep) else onIncrementItem(rep) },
                        onDecrement = {
                            if (isGroup) onRemovePortion(line.ids.last())
                            else if (isWeight) onCancelItem(rep)
                            else onDecrementItem(rep)
                        },
                    )
                } else {
                    OrderLineCard(
                        item = rep,
                        portions = line.portions,
                        canCancel = false,
                        canToggleServed = order.status == OrderStatus.BILL_REQUESTED,
                        onCancel = {},
                        onToggleServed = { onToggleServed(rep) },
                        onIncrement = {},
                        onDecrement = {},
                        showInlineQtyControls = false,
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
private fun SwipeableOrderLine(
    item: OrderItemDto,
    portions: Int = 1,
    canVoid: Boolean = true,
    onCancel: () -> Unit,
    onEditNote: () -> Unit,
    onToggleServed: () -> Unit,
    onIncrement: () -> Unit,
    onDecrement: () -> Unit,
) {
    val dismissState = androidx.compose.material3.rememberSwipeToDismissBoxState(
        positionalThreshold = { distance -> distance * 0.35f },
        confirmValueChange = { value ->
            when (value) {
                androidx.compose.material3.SwipeToDismissBoxValue.EndToStart -> {
                    if (canVoid) onCancel() // без права orders.void — свайп-отмена недоступна
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
        enableDismissFromEndToStart = canVoid, // свайп-отмена позиции — только при праве
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
                portions = portions,
                canCancel = false,
                canToggleServed = true,
                onCancel = {},
                onToggleServed = onToggleServed,
                onIncrement = onIncrement,
                onDecrement = onDecrement,
                showInlineQtyControls = true,
            )
        },
    )
}

@Composable
private fun OrderLineCard(
    item: OrderItemDto,
    portions: Int = 1,
    canCancel: Boolean,
    canToggleServed: Boolean,
    onCancel: () -> Unit,
    onToggleServed: () -> Unit,
    onIncrement: () -> Unit = {},
    onDecrement: () -> Unit = {},
    showInlineQtyControls: Boolean = false,
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
                // Статус готовки от повара (KDS): «Готовится» / «Готово».
                // served уже показан зачёркиванием, pending — не показываем.
                when (item.kitchenStatus) {
                    "cooking" -> KitchenBadge("Готовится", Color(0xFFF59E0B))
                    "ready" -> KitchenBadge("Готово", Color(0xFF22C55E))
                }
                Text(
                    run {
                        val isWeight = item.unit == "g" || item.unit == "kg"
                        val priceStr = formatCurrency(item.priceAtOrder.toBigDecimalSafe())
                        if (isWeight) {
                            val w = formatOrderWeight(item.qtyDec, item.unit)
                            if (portions > 1) "$w × $portions · $priceStr" else "$w · $priceStr"
                        } else {
                            "${item.qty} × $priceStr"
                        }
                    },
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
            // iiko-style +/− inline controls (только в fresh-статусах).
            if (showInlineQtyControls) {
                androidx.compose.material3.IconButton(
                    onClick = onDecrement,
                    modifier = Modifier.size(32.dp),
                ) {
                    Icon(
                        Icons.Outlined.Remove,
                        contentDescription = "−1",
                        modifier = Modifier.size(16.dp),
                        tint = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
                    )
                }
                androidx.compose.material3.IconButton(
                    onClick = onIncrement,
                    modifier = Modifier.size(32.dp),
                ) {
                    Icon(
                        Icons.Outlined.Add,
                        contentDescription = "+1",
                        modifier = Modifier.size(18.dp),
                        tint = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
                    )
                }
            }
            Text(
                // Строка может объединять N одинаковых порций (portions) — показываем
                // сумму всей группы = subtotal одной позиции × portions.
                formatCurrency(item.subtotal.toBigDecimalSafe() * portions.toBigDecimal()),
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
            val subtotalBd = order.subtotal.toBigDecimalSafe()
            val discountBd = order.discountAmount.toBigDecimalSafe()
            // service_amount бэк заполняет только при ЗАКРЫТИИ заказа. Для
            // открытого заказа официант должен видеть ожидаемое обслуживание —
            // считаем его из service_percent заказа (subtotal × %/100).
            val percentBd = order.servicePercent.toBigDecimalSafe()
            val storedSvc = order.serviceChargeAmount.toBigDecimalSafe()
            val serviceBd = if (storedSvc > BigDecimal.ZERO) {
                storedSvc
            } else if (percentBd > BigDecimal.ZERO) {
                (subtotalBd * percentBd).divide(BigDecimal(100), 2, java.math.RoundingMode.HALF_EVEN)
            } else {
                BigDecimal.ZERO
            }
            Row(
                modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text("Подытог", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.65f))
                Text(formatCurrency(subtotalBd), fontSize = 13.sp)
            }
            if (serviceBd > BigDecimal.ZERO) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text(
                        if (percentBd > BigDecimal.ZERO) "Обслуживание (${percentBd.stripTrailingZeros().toPlainString()}%)" else "Обслуживание",
                        fontSize = 13.sp,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.65f),
                    )
                    Text(formatCurrency(serviceBd), fontSize = 13.sp)
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
            // Итого: если service_amount уже в order.total (закрытый заказ) —
            // берём order.total. Иначе считаем subtotal + обслуживание − скидка
            // (открытый заказ, где бэк ещё не зафиксировал service_amount).
            val displayTotal = if (storedSvc > BigDecimal.ZERO) {
                order.total.toBigDecimalSafe()
            } else {
                subtotalBd + serviceBd - discountBd
            }
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text("Итого", fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
                Text(
                    formatCurrency(displayTotal),
                    fontWeight = FontWeight.Bold,
                    fontSize = 16.sp,
                )
            }
        }
    }
}

/** Нижняя панель — только «Добавить». Остальные действия ушли в ⋮ топ-бара. */
@Composable
private fun AddItemsBar(
    order: OrderDto,
    busy: Boolean,
    onAddItems: () -> Unit,
) {
    Surface(color = MaterialTheme.colorScheme.surface, shadowElevation = 8.dp) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(horizontal = 12.dp, vertical = 12.dp),
        ) {
            Button(
                onClick = onAddItems,
                enabled = !busy && OrderStatus.isFresh(order.status),
                modifier = Modifier.fillMaxWidth().height(48.dp),
            ) {
                Icon(Icons.Outlined.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text("Добавить", fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

/**
 * ⋮ в правом верхнем углу: печать пре-чека, передача официанту, перенос стола
 * (и отмена заказа при праве orders.cancel). Раньше это были 3 ряда кнопок снизу.
 */
@Composable
private fun OrderOverflowMenu(
    hasTable: Boolean,
    canCancel: Boolean,
    busy: Boolean,
    onPrintPreBill: () -> Unit,
    onAssignWaiter: () -> Unit,
    onTransferTable: () -> Unit,
    onCancelOrder: () -> Unit,
) {
    val open = remember { androidx.compose.runtime.mutableStateOf(false) }
    Box {
        IconButton(onClick = { open.value = true }) {
            Icon(Icons.Outlined.MoreVert, contentDescription = "Ещё")
        }
        DropdownMenu(expanded = open.value, onDismissRequest = { open.value = false }) {
            DropdownMenuItem(
                text = { Text("Печать пре-чека") },
                enabled = !busy,
                leadingIcon = { Icon(Icons.Outlined.Receipt, contentDescription = null) },
                onClick = { open.value = false; onPrintPreBill() },
            )
            DropdownMenuItem(
                text = { Text("Передать другому официанту") },
                enabled = !busy,
                leadingIcon = { Icon(Icons.Outlined.SwapHoriz, contentDescription = null) },
                onClick = { open.value = false; onAssignWaiter() },
            )
            if (hasTable) {
                DropdownMenuItem(
                    text = { Text("Перенести стол") },
                    enabled = !busy,
                    leadingIcon = { Icon(Icons.Outlined.Place, contentDescription = null) },
                    onClick = { open.value = false; onTransferTable() },
                )
            }
            if (canCancel) {
                DropdownMenuItem(
                    text = { Text("Отменить заказ", color = MaterialTheme.colorScheme.error) },
                    enabled = !busy,
                    leadingIcon = {
                        Icon(
                            Icons.Outlined.Block,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.error,
                        )
                    },
                    onClick = { open.value = false; onCancelOrder() },
                )
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

@Composable
private fun KitchenBadge(text: String, color: Color) {
    Box(
        Modifier
            .padding(top = 2.dp)
            .clip(RoundedCornerShape(6.dp))
            .background(color.copy(alpha = 0.15f))
            .padding(horizontal = 6.dp, vertical = 1.dp),
    ) {
        Text(text, fontSize = 10.sp, fontWeight = FontWeight.SemiBold, color = color)
    }
}
