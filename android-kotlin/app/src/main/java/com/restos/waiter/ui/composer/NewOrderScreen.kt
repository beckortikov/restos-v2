package com.restos.waiter.ui.composer

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
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
import androidx.compose.material.icons.outlined.Remove
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.ShoppingCart
import androidx.compose.material3.Button
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.restos.waiter.data.menu.CategoryDto
import com.restos.waiter.data.menu.MenuItemDto
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

    LaunchedEffect(state.createdOrderId) {
        state.createdOrderId?.let(onOrderCreated)
    }
    LaunchedEffect(state.error) {
        state.error?.let {
            snackbar.showSnackbar(it)
            viewModel.consumeError()
        }
    }

    if (!state.guestsConfirmed && !state.loading) {
        GuestsDialog(
            onDismiss = onBack,
            onPick = viewModel::setGuests,
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
                submitLabel = if (viewModel.isAppendMode) "Добавить" else "Создать заказ",
                onSubmit = viewModel::submit,
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
                onAdd = viewModel::addToCart,
                onInc = viewModel::increment,
                onDec = viewModel::decrement,
                onRemove = viewModel::remove,
            )
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
    @Suppress("UNUSED_PARAMETER") onRemove: (String) -> Unit,
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
            onPick = onAdd,
            onInc = onInc,
            onDec = onDec,
            modifier = Modifier.fillMaxSize(),
        )
    }
}

private fun filterMenu(state: NewOrderUiState): List<MenuItemDto> {
    val q = state.search.trim().lowercase()
    val byCat = if (state.selectedCategoryId == null || q.isNotBlank()) state.items
    else state.items.filter { it.category == state.selectedCategoryId }
    return if (q.isBlank()) byCat
    else byCat.filter { it.name.lowercase().contains(q) }
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

@Composable
private fun CategoriesRow(
    categories: List<CategoryDto>,
    selectedId: String?,
    onSelect: (String?) -> Unit,
) {
    if (categories.isEmpty()) return
    androidx.compose.foundation.lazy.LazyRow(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(categories, key = { it.id }) { cat ->
            Chip(
                label = cat.name,
                active = cat.id == selectedId,
                onClick = { onSelect(cat.id) },
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
    onPick: (MenuItemDto) -> Unit,
    onInc: (String) -> Unit,
    onDec: (String) -> Unit,
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
            val qty = cart.firstOrNull { it.menuItemId == item.id }?.qty ?: 0
            MenuListRow(
                item = item,
                qtyInCart = qty,
                onPick = { onPick(item) },
                onInc = { onInc(item.id) },
                onDec = { onDec(item.id) },
            )
        }
    }
}

@Composable
private fun MenuListRow(
    item: MenuItemDto,
    qtyInCart: Int,
    onPick: () -> Unit,
    onInc: () -> Unit,
    onDec: () -> Unit,
) {
    val disabled = !item.isAvailable
    val inCart = qtyInCart > 0
    val bg = if (inCart) Color(0xFFFFF7ED)
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
                    text = formatCurrency(item.price.toBigDecimalSafe()),
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Medium,
                    color = if (disabled) MaterialTheme.colorScheme.onSurface.copy(alpha = 0.4f)
                    else MaterialTheme.colorScheme.primary,
                )
            }
            // Справа: либо [-] qty [+], либо только [+]
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
                formatCurrency(line.price.toBigDecimalSafe() * line.qty.toBigDecimal()),
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
