package com.restos.waiter.ui.composer

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.FlowRowOverflow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
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
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.Remove
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.ShoppingCart
import androidx.compose.material3.Button
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
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
import com.restos.waiter.data.menu.CategoryDto
import com.restos.waiter.data.menu.MenuItemDto
import com.restos.waiter.util.Translit
import com.restos.waiter.util.formatCurrency
import java.math.BigDecimal

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewOrderScreen(
    onBack: () -> Unit,
    onOrderCreated: (orderId: String) -> Unit,
    viewModel: NewOrderViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    // Превью перед отправкой на кухню (item 4): корзина уходит на подтверждение,
    // а не создаёт заказ сразу.
    var showPreview by rememberSaveable { mutableStateOf(false) }

    LaunchedEffect(state.createdOrderId) {
        state.createdOrderId?.let(onOrderCreated)
    }
    LaunchedEffect(state.error) {
        state.error?.let {
            // Закрываем превью, чтобы снекбар с ошибкой был виден; ключ
            // идемпотентности в VM сохранён — повторная отправка безопасна.
            showPreview = false
            snackbar.showSnackbar(it)
            viewModel.consumeError()
        }
    }
    // Если в превью убрали все позиции — закрываем лист.
    LaunchedEffect(state.cart.isEmpty()) {
        if (state.cart.isEmpty()) showPreview = false
    }

    // Диалог количества гостей: быстрые кнопки 1–6 + «Больше 6» со счётчиком.
    if (!state.guestsConfirmed && !state.loading) {
        GuestsDialog(
            onDismiss = onBack,
            onPick = viewModel::setGuests,
        )
    }

    // Диалог ввода веса для весового блюда (граммы/кг).
    state.weightItem?.let { wItem ->
        WeightDialog(
            item = wItem,
            initialGrams = viewModel.currentWeight(wItem.id),
            initialPortions = viewModel.currentPortions(wItem.id),
            onDismiss = viewModel::dismissWeight,
            onConfirm = { grams, portions -> viewModel.confirmWeight(grams, portions) },
        )
    }

    Scaffold(
        topBar = {
            CenterAlignedTopAppBar(
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Назад")
                    }
                },
                title = {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(
                            state.table?.name ?: "Новый заказ",
                            fontWeight = FontWeight.SemiBold,
                        )
                        val subtitle = listOfNotNull(
                            state.table?.zoneName,
                            if (state.table != null) "${state.guests} гостей" else null,
                        ).joinToString(" · ")
                        if (subtitle.isNotBlank()) {
                            Text(
                                subtitle,
                                fontSize = 11.sp,
                                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                            )
                        }
                    }
                },
            )
        },
        bottomBar = {
            CartBar(
                cartCount = state.cart.sumOf { it.qty },
                cartTotal = viewModel.cartTotal(),
                busy = state.busy,
                canSubmit = state.cart.isNotEmpty(),
                // Кнопка открывает превью, а не отправляет заказ сразу (item 4).
                submitLabel = if (viewModel.isAppendMode) "Проверить и добавить" else "Проверить заказ",
                onSubmit = { showPreview = true },
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
        containerColor = MaterialTheme.colorScheme.background,
    ) { inner ->
        Box(Modifier.fillMaxSize().padding(inner)) {
            // Без спиннера — если кэша нет, экран короткое время «пустой»,
            // потом данные подтягиваются. Это всё равно быстрее визуально, чем
            // прыгающий CircularProgressIndicator.
            ComposerBody(
                state = state,
                onSearch = viewModel::setSearch,
                onSelectCategory = viewModel::selectCategory,
                onAdd = viewModel::pick,
                onInc = viewModel::increment,
                onDec = viewModel::decrement,
                onRemove = viewModel::remove,
            )
        }
    }

    // Превью заказа перед отправкой на кухню: официант может уменьшить/удалить
    // позиции или отменить, и только затем подтвердить создание/дозаказ.
    if (showPreview && state.cart.isNotEmpty()) {
        OrderPreviewSheet(
            cart = state.cart,
            total = viewModel.cartTotal(),
            busy = state.busy,
            confirmLabel = if (viewModel.isAppendMode) "Добавить к заказу" else "Отправить на кухню",
            onInc = viewModel::increment,
            onDec = viewModel::decrement,
            onRemove = viewModel::remove,
            onConfirm = viewModel::submit,
            onDismiss = { showPreview = false },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun OrderPreviewSheet(
    cart: List<CartLine>,
    total: BigDecimal,
    busy: Boolean,
    confirmLabel: String,
    onInc: (String) -> Unit,
    onDec: (String) -> Unit,
    onRemove: (String) -> Unit,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = { if (!busy) onDismiss() },
        sheetState = sheetState,
        containerColor = MaterialTheme.colorScheme.surface,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp)
                .navigationBarsPadding(),
        ) {
            Text(
                "Проверьте заказ",
                fontSize = 18.sp,
                fontWeight = FontWeight.Bold,
            )
            Text(
                "Перед отправкой на кухню можно изменить количество или убрать позицию.",
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                modifier = Modifier.padding(top = 2.dp, bottom = 12.dp),
            )
            LazyColumn(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 380.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(cart, key = { it.menuItemId }) { line ->
                    PreviewLineRow(
                        line = line,
                        onInc = { onInc(line.menuItemId) },
                        onDec = { onDec(line.menuItemId) },
                        onRemove = { onRemove(line.menuItemId) },
                    )
                }
            }
            HorizontalDivider(modifier = Modifier.padding(vertical = 12.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("Итого", fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                Text(
                    formatCurrency(total),
                    fontSize = 18.sp,
                    fontWeight = FontWeight.Bold,
                )
            }
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 12.dp, bottom = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                OutlinedButton(
                    onClick = onDismiss,
                    enabled = !busy,
                    modifier = Modifier.weight(1f).height(52.dp),
                ) {
                    Text("Отмена", fontWeight = FontWeight.SemiBold)
                }
                Button(
                    onClick = onConfirm,
                    enabled = !busy,
                    modifier = Modifier.weight(1.4f).height(52.dp),
                ) {
                    if (busy) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(18.dp),
                            color = MaterialTheme.colorScheme.onPrimary,
                            strokeWidth = 2.dp,
                        )
                    } else {
                        Text(confirmLabel, fontWeight = FontWeight.SemiBold)
                    }
                }
            }
        }
    }
}

@Composable
private fun PreviewLineRow(
    line: CartLine,
    onInc: () -> Unit,
    onDec: () -> Unit,
    onRemove: () -> Unit,
) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.25f),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    line.name,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    formatCurrency(line.lineTotal()) +
                        if (line.isWeight && line.weightQty != null)
                            " · ${line.qty} × ${formatWeight(line.weightQty, line.unit)}"
                        else "",
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Medium,
                    color = MaterialTheme.colorScheme.primary,
                )
            }
            if (line.isWeight) {
                // Вес правится в основном списке через диалог — здесь только удаление.
                QtySquare(
                    text = "✕",
                    bg = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.7f),
                    fg = MaterialTheme.colorScheme.error,
                    onClick = onRemove,
                )
            } else {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    QtySquare(
                        text = "−",
                        bg = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.7f),
                        fg = MaterialTheme.colorScheme.onSurface,
                        onClick = onDec,
                    )
                    Text(
                        line.qty.toString(),
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier.padding(horizontal = 10.dp),
                    )
                    QtySquare(
                        text = "+",
                        bg = MaterialTheme.colorScheme.primary,
                        fg = MaterialTheme.colorScheme.onPrimary,
                        onClick = onInc,
                    )
                    Spacer(Modifier.width(6.dp))
                    IconButton(onClick = onRemove, modifier = Modifier.size(32.dp)) {
                        Icon(
                            Icons.Outlined.Close,
                            contentDescription = "Удалить",
                            tint = MaterialTheme.colorScheme.error,
                            modifier = Modifier.size(18.dp),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ComposerBody(
    state: NewOrderUiState,
    onSearch: (String) -> Unit,
    onSelectCategory: (String?) -> Unit,
    onAdd: (MenuItemDto) -> Unit,
    onInc: (String) -> Unit,
    onDec: (String) -> Unit,
    onRemove: (String) -> Unit,
) {
    Column(modifier = Modifier.fillMaxSize().padding(horizontal = 12.dp, vertical = 8.dp)) {
        SearchField(state.search, onSearch)
        Spacer(Modifier.height(8.dp))
        CategoriesRow(state.categories, state.selectedCategoryId, onSelectCategory)
        Spacer(Modifier.height(8.dp))

        // Единый список меню с inline [-] qty [+]; корзинная панель убрана —
        // итог и счётчик уходят в нижний CartBar.
        MenuList(
            items = filterMenu(state),
            cart = state.cart,
            batchAvail = state.batchAvail,
            onPick = onAdd,
            onInc = onInc,
            onDec = onDec,
            onRemove = onRemove,
            modifier = Modifier.fillMaxSize(),
        )
    }
}

private fun filterMenu(state: NewOrderUiState): List<MenuItemDto> {
    val q = state.search.trim().lowercase()
    // Стоп-блюда уходят из меню официанта (он не пробивает стоп): недоступно,
    // ручной стоп или заготовка без готовых порций. Видны только в стоп-листе.
    val visible = state.items.filter { item ->
        item.isAvailable && !item.stopListOverride &&
            !(item.isBatchCooking && (state.batchAvail[item.id] ?: item.preparedQty) <= 0)
    }
    // .trim() обязателен: чипы категорий строятся по обрезанным именам
    // (buildCategories), а menu_items.category может прийти с лишними пробелами.
    // Без trim блюдо с пробелом в категории пропадало при выборе своей вкладки
    // (в POS видно, у официанта — нет). OrderDetailScreen уже сравнивает с trim.
    val byCat = if (state.selectedCategoryId == null || q.isNotBlank()) visible
    else visible.filter { it.category?.trim() == state.selectedCategoryId }
    // Кросслитеральный поиск: «plov» находит «Плов» и наоборот (см. Translit).
    return if (q.isBlank()) byCat
    else byCat.filter { Translit.matches(it.name, state.search) }
    // Порядок списка НЕ меняем: добавленное блюдо остаётся на своём месте, а не
    // прыгает в топ и не исчезает из поля зрения (partition-to-top убран).
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SearchField(value: String, onChange: (String) -> Unit) {
    TextField(
        value = value,
        onValueChange = onChange,
        placeholder = { Text("Поиск блюда") },
        leadingIcon = { Icon(Icons.Outlined.Search, contentDescription = null) },
        trailingIcon = if (value.isNotEmpty()) {
            @Composable {
                IconButton(onClick = { onChange("") }) {
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
    )
}

/**
 * Категории — раскрывающаяся строка (не горизонтальный скролл). В свёрнутом
 * виде один ряд + чип «Ещё»: тап разворачивает ВСЕ категории вниз переносом
 * (FlowRow), появляется чип «Свернуть».
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun CategoriesRow(
    categories: List<CategoryDto>,
    selectedId: String?,
    onSelect: (String?) -> Unit,
) {
    if (categories.isEmpty()) return
    var expanded by rememberSaveable { mutableStateOf(false) }
    FlowRow(
        modifier = Modifier.fillMaxWidth().animateContentSize(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
        maxLines = if (expanded) Int.MAX_VALUE else 1,
        overflow = FlowRowOverflow.expandOrCollapseIndicator(
            minRowsToShowCollapse = 2,
            expandIndicator = {
                ToggleChip(
                    label = "Ещё",
                    icon = Icons.Outlined.ExpandMore,
                    onClick = { expanded = true },
                )
            },
            collapseIndicator = {
                ToggleChip(
                    label = "Свернуть",
                    icon = Icons.Outlined.ExpandLess,
                    onClick = { expanded = false },
                )
            },
        ),
    ) {
        Chip(
            label = "Все",
            active = selectedId == null,
            onClick = { onSelect(null) },
        )
        categories.forEach { cat ->
            Chip(
                label = cat.name,
                active = cat.id == selectedId,
                onClick = { onSelect(cat.id) },
            )
        }
    }
}

@Composable
private fun ToggleChip(
    label: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    onClick: () -> Unit,
) {
    Surface(
        shape = RoundedCornerShape(50),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
        onClick = onClick,
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(start = 12.dp, end = 10.dp, top = 8.dp, bottom = 8.dp),
        ) {
            Text(
                label,
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
                color = MaterialTheme.colorScheme.onSurface,
            )
            Spacer(Modifier.width(2.dp))
            Icon(
                icon,
                contentDescription = null,
                modifier = Modifier.size(18.dp),
                tint = MaterialTheme.colorScheme.onSurface,
            )
        }
    }
}

@Composable
private fun Chip(label: String, active: Boolean, onClick: () -> Unit) {
    Surface(
        shape = RoundedCornerShape(50),
        color = if (active) MaterialTheme.colorScheme.primary
        else MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
        onClick = onClick,
    ) {
        Text(
            label,
            fontSize = 13.sp,
            fontWeight = FontWeight.Medium,
            color = if (active) MaterialTheme.colorScheme.onPrimary
            else MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
        )
    }
}

@Composable
private fun MenuList(
    items: List<MenuItemDto>,
    cart: List<CartLine>,
    batchAvail: Map<String, Int>,
    onPick: (MenuItemDto) -> Unit,
    onInc: (String) -> Unit,
    onDec: (String) -> Unit,
    onRemove: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (items.isEmpty()) {
        Box(modifier.fillMaxSize(), Alignment.Center) {
            Text(
                "Ничего не найдено",
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f),
            )
        }
        return
    }
    LazyColumn(
        modifier = modifier,
        verticalArrangement = Arrangement.spacedBy(6.dp),
        contentPadding = PaddingValues(bottom = 96.dp),
    ) {
        items(items, key = { it.id }) { item ->
            val line = cart.firstOrNull { it.menuItemId == item.id }
            MenuListRow(
                item = item,
                line = line,
                batchAvailable = if (item.isBatchCooking) (batchAvail[item.id] ?: item.preparedQty) else null,
                onPick = { onPick(item) },
                onInc = { onInc(item.id) },
                onDec = { onDec(item.id) },
                onRemove = { onRemove(item.id) },
            )
        }
    }
}

@Composable
private fun MenuListRow(
    item: MenuItemDto,
    line: CartLine?,
    batchAvailable: Int?,
    onPick: () -> Unit,
    onInc: () -> Unit,
    onDec: () -> Unit,
    onRemove: () -> Unit,
) {
    val disabled = !item.isAvailable
    val isWeight = item.isWeighed()
    val qtyInCart = line?.qty ?: 0
    val inCart = if (isWeight) line?.isWeight == true else qtyInCart > 0
    val bg = if (inCart) MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.45f)
    else MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.25f)

    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .height(64.dp),
        shape = RoundedCornerShape(12.dp),
        color = bg,
        onClick = onPick,
        enabled = !disabled,
    ) {
        Row(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // Название + цена
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = item.name,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    color = MaterialTheme.colorScheme.onSurface
                        .copy(alpha = if (disabled) 0.4f else 1f),
                )
                Text(
                    text = formatCurrency(item.price.toBigDecimalSafe()) +
                        if (isWeight) " / ${weightUnitLabel(item)}" else "",
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Medium,
                    color = if (disabled) MaterialTheme.colorScheme.onSurface.copy(alpha = 0.4f)
                    else MaterialTheme.colorScheme.primary,
                )
            }
            // Заготовка: серый бейдж «доступно сейчас» (с учётом незакрытых заказов).
            if (batchAvailable != null) {
                Surface(
                    color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.7f),
                    shape = RoundedCornerShape(8.dp),
                ) {
                    Text(
                        "$batchAvailable порц.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
                    )
                }
                Spacer(Modifier.width(8.dp))
            }

            // Справа: стоп / весовая пилюля / [-] qty [+] / [+]
            if (disabled) {
                Surface(
                    color = Color(0xFFFEE2E2),
                    shape = RoundedCornerShape(6.dp),
                ) {
                    Text(
                        "Стоп",
                        color = Color(0xFFBE123C),
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                    )
                }
            } else if (isWeight) {
                // Весовое блюдо: [−] убирает из выбора, пилюля → диалог веса.
                if (inCart && line?.weightQty != null) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        QtySquare(
                            text = "−",
                            bg = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.7f),
                            fg = MaterialTheme.colorScheme.onSurface,
                            onClick = onRemove,
                        )
                        Spacer(Modifier.width(8.dp))
                        Surface(
                            shape = RoundedCornerShape(8.dp),
                            color = MaterialTheme.colorScheme.primary,
                            onClick = onPick,
                        ) {
                            Text(
                                if (line.qty > 1) "${line.qty} × ${formatWeight(line.weightQty, item.unit)}"
                                else formatWeight(line.weightQty, item.unit),
                                color = MaterialTheme.colorScheme.onPrimary,
                                fontSize = 13.sp,
                                fontWeight = FontWeight.Bold,
                                modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                            )
                        }
                    }
                } else {
                    QtySquare(
                        text = "+",
                        bg = MaterialTheme.colorScheme.primary,
                        fg = MaterialTheme.colorScheme.onPrimary,
                        onClick = onPick,
                    )
                }
            } else if (inCart) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    QtySquare(
                        text = "−",
                        bg = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.7f),
                        fg = MaterialTheme.colorScheme.onSurface,
                        onClick = onDec,
                    )
                    Text(
                        qtyInCart.toString(),
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier.padding(horizontal = 10.dp),
                    )
                    QtySquare(
                        text = "+",
                        bg = MaterialTheme.colorScheme.primary,
                        fg = MaterialTheme.colorScheme.onPrimary,
                        onClick = onInc,
                    )
                }
            } else {
                QtySquare(
                    text = "+",
                    bg = MaterialTheme.colorScheme.primary,
                    fg = MaterialTheme.colorScheme.onPrimary,
                    onClick = onPick,
                )
            }
        }
    }
}

@Composable
private fun QtySquare(text: String, bg: Color, fg: Color, onClick: () -> Unit) {
    Surface(
        modifier = Modifier.size(36.dp),
        shape = RoundedCornerShape(8.dp),
        color = bg,
        onClick = onClick,
    ) {
        Box(contentAlignment = Alignment.Center) {
            Text(text, color = fg, fontSize = 18.sp, fontWeight = FontWeight.Bold)
        }
    }
}

@Suppress("UnusedPrivateMember")
@Composable
private fun MenuItemCard(item: MenuItemDto, qtyInCart: Int, onClick: () -> Unit) {
    val disabled = !item.isAvailable
    val inCart = qtyInCart > 0
    val border = when {
        inCart -> MaterialTheme.colorScheme.primary
        else -> MaterialTheme.colorScheme.surfaceVariant
    }
    val borderWidth = if (inCart) 2.dp else 1.dp
    val bg = MaterialTheme.colorScheme.surface
    val alpha = if (disabled) 0.5f else 1f

    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .aspectRatio(1f)  // квадрат, как DishTile в React
            .border(borderWidth, border, RoundedCornerShape(12.dp)),
        shape = RoundedCornerShape(12.dp),
        color = bg,
        onClick = onClick,
        enabled = !disabled,
    ) {
        Box(modifier = Modifier.fillMaxSize()) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(8.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.SpaceBetween,
            ) {
                // Emoji или плейсхолдер
                Text(
                    text = item.emoji.ifBlank { "🍽" },
                    fontSize = 28.sp,
                    modifier = Modifier.padding(top = 4.dp),
                )
                // Название
                Text(
                    text = item.name,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Bold,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = alpha),
                    modifier = Modifier.fillMaxWidth(),
                )
                // Цена
                Text(
                    text = formatCurrency(item.price.toBigDecimalSafe()),
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.primary.copy(alpha = alpha),
                )
            }

            // Badge "СТОП" слева сверху
            if (disabled) {
                Surface(
                    modifier = Modifier
                        .align(Alignment.TopStart)
                        .padding(6.dp),
                    color = Color(0xFFFEE2E2),
                    shape = RoundedCornerShape(6.dp),
                ) {
                    Text(
                        "Стоп",
                        color = Color(0xFFBE123C),
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier.padding(horizontal = 5.dp, vertical = 1.dp),
                    )
                }
            }
            // Badge кол-ва в корзине справа сверху
            if (inCart) {
                Surface(
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .padding(4.dp)
                        .size(20.dp),
                    color = MaterialTheme.colorScheme.primary,
                    shape = RoundedCornerShape(50),
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        Text(
                            qtyInCart.toString(),
                            color = MaterialTheme.colorScheme.onPrimary,
                            fontSize = 11.sp,
                            fontWeight = FontWeight.Bold,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun CartPanel(
    cart: List<CartLine>,
    onInc: (String) -> Unit,
    onDec: (String) -> Unit,
    onRemove: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(
        modifier = modifier
            .border(1.dp, MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(12.dp)),
        shape = RoundedCornerShape(12.dp),
        color = MaterialTheme.colorScheme.surface,
    ) {
        Column(modifier = Modifier.fillMaxSize().padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.ShoppingCart, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text("Корзина", fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.weight(1f))
                if (cart.isNotEmpty()) {
                    Text(
                        "${cart.sumOf { it.qty }} поз.",
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                    )
                }
            }
            Spacer(Modifier.height(8.dp))
            if (cart.isEmpty()) {
                Box(Modifier.fillMaxSize(), Alignment.Center) {
                    Text(
                        "Пусто",
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f),
                    )
                }
            } else {
                LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxSize()) {
                    items(cart, key = { it.menuItemId }) { line ->
                        CartLineRow(line, onInc, onDec, onRemove)
                    }
                }
            }
        }
    }
}

@Composable
private fun CartLineRow(
    line: CartLine,
    onInc: (String) -> Unit,
    onDec: (String) -> Unit,
    onRemove: (String) -> Unit,
) {
    Column(modifier = Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                line.name,
                modifier = Modifier.weight(1f),
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            IconButton(onClick = { onRemove(line.menuItemId) }, modifier = Modifier.size(28.dp)) {
                Icon(
                    Icons.Outlined.Close,
                    contentDescription = "Удалить",
                    tint = MaterialTheme.colorScheme.error,
                    modifier = Modifier.size(16.dp),
                )
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 2.dp)) {
            QtyButton(icon = Icons.Outlined.Remove, onClick = { onDec(line.menuItemId) })
            Text(
                line.qty.toString(),
                modifier = Modifier.padding(horizontal = 12.dp),
                fontWeight = FontWeight.SemiBold,
            )
            QtyButton(icon = Icons.Outlined.Add, onClick = { onInc(line.menuItemId) })
            Spacer(Modifier.weight(1f))
            Text(
                // lineTotal() учитывает вес (price × qty/unitSize × порции), а не
                // наивное price × qty (раздувало весовые позиции).
                formatCurrency(line.lineTotal()),
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
            )
        }
    }
}

@Composable
private fun QtyButton(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    onClick: () -> Unit,
) {
    Surface(
        modifier = Modifier.size(32.dp),
        shape = RoundedCornerShape(8.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
        onClick = onClick,
    ) {
        Box(contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription = null, modifier = Modifier.size(16.dp))
        }
    }
}

@Composable
private fun CartBar(
    cartCount: Int,
    cartTotal: BigDecimal,
    busy: Boolean,
    canSubmit: Boolean,
    submitLabel: String,
    onSubmit: () -> Unit,
) {
    Surface(color = MaterialTheme.colorScheme.surface, shadowElevation = 8.dp) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(horizontal = 12.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    "$cartCount поз.",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                )
                Text(formatCurrency(cartTotal), fontWeight = FontWeight.Bold, fontSize = 18.sp)
            }
            Button(
                onClick = onSubmit,
                enabled = !busy && canSubmit,
                modifier = Modifier.height(48.dp),
            ) {
                if (busy) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(18.dp),
                        color = MaterialTheme.colorScheme.onPrimary,
                        strokeWidth = 2.dp,
                    )
                } else {
                    Text(submitLabel, fontWeight = FontWeight.SemiBold)
                }
            }
        }
    }
}

private fun String.toBigDecimalSafe(): BigDecimal =
    runCatching { BigDecimal(this) }.getOrDefault(BigDecimal.ZERO)

/** Метка цены для весового блюда: «100г» / «кг». */
private fun weightUnitLabel(item: MenuItemDto): String {
    if (item.unit == "kg") return "кг"
    val size = item.unitSize.toBigDecimalSafe()
    val n = if (size > BigDecimal.ZERO) size.stripTrailingZeros().toPlainString() else "100"
    return "${n}г"
}

/** Формат выбранного веса в строке корзины: «250 г» / «0.5 кг». */
private fun formatWeight(weight: String, unit: String): String {
    val v = weight.toBigDecimalSafe().stripTrailingZeros().toPlainString()
    return if (unit == "kg") "$v кг" else "$v г"
}
