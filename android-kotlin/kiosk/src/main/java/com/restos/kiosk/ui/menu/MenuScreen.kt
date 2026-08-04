package com.restos.kiosk.ui.menu

import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Remove
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
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
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.restos.kiosk.data.menu.MenuItemDto
import com.restos.kiosk.data.orders.OrderType
import com.restos.kiosk.ui.theme.KioskColors
import com.restos.kiosk.ui.theme.KioskRadius
import com.restos.kiosk.util.formatSom
import java.math.BigDecimal

@Composable
fun MenuScreen(
    onOrderCreated: (orderId: String, orderNumber: Int?) -> Unit,
    onCancel: () -> Unit,
    viewModel: MenuViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    LaunchedEffect(state.createdOrder) {
        state.createdOrder?.let { onOrderCreated(it.id, it.orderNumber) }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        Surface(modifier = Modifier.fillMaxSize(), color = KioskColors.Bg) {
            Column(modifier = Modifier.fillMaxSize().systemBarsPadding()) {
                Header(orderType = viewModel.orderType, onCancel = onCancel)

                if (state.loading) {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(color = KioskColors.Primary)
                    }
                    return@Column
                }

                SearchField(value = state.search, onValueChange = viewModel::setSearch)

                if (state.search.isBlank()) {
                    CategoryRow(
                        categories = state.categories,
                        selectedId = state.selectedCategoryId,
                        onSelect = viewModel::selectCategory,
                    )
                }

                val filtered = if (state.search.isNotBlank()) {
                    state.items.filter { it.name.contains(state.search, ignoreCase = true) }
                } else {
                    state.items.filter { item ->
                        state.selectedCategoryId == null || item.category == state.selectedCategoryId
                    }
                }

                if (filtered.isEmpty()) {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Text("Ничего не найдено", color = KioskColors.TextSecondary, style = MaterialTheme.typography.bodyLarge)
                    }
                } else {
                    // Полный экран без внешних отступов — карточки идут от края
                    // до края слева/справа/сверху/снизу, разделены только
                    // тонким зазором между собой.
                    LazyVerticalGrid(
                        columns = GridCells.Fixed(2),
                        modifier = Modifier.weight(1f).fillMaxWidth(),
                        contentPadding = PaddingValues(0.dp),
                        horizontalArrangement = Arrangement.spacedBy(2.dp),
                        verticalArrangement = Arrangement.spacedBy(2.dp),
                    ) {
                        items(filtered, key = { it.id }) { item ->
                            MenuItemCard(
                                item = item,
                                qtyInCart = viewModel.qtyInCart(item.id),
                                onAdd = { viewModel.addToCart(item) },
                                onIncrement = { viewModel.increment(item.id) },
                                onDecrement = { viewModel.decrement(item.id) },
                            )
                        }
                    }
                }

                CartBar(
                    count = viewModel.cartCount(),
                    total = viewModel.cartTotal(),
                    enabled = state.cart.isNotEmpty(),
                    onSubmit = viewModel::openPreview,
                )
            }
        }

        if (state.showPreview) {
            OrderPreviewSheet(
                cart = state.cart,
                total = viewModel.cartTotal(),
                busy = state.busy,
                onDismiss = viewModel::dismissPreview,
                onIncrement = viewModel::increment,
                onDecrement = viewModel::decrement,
                onRemove = viewModel::remove,
                onConfirm = viewModel::submit,
            )
        }

        if (state.error != null) {
            AlertDialog(
                onDismissRequest = viewModel::consumeError,
                title = { Text("Не получилось") },
                text = { Text(state.error.orEmpty()) },
                confirmButton = {
                    TextButton(onClick = viewModel::consumeError) { Text("Понятно") }
                },
            )
        }
    }
}

@Composable
private fun Header(orderType: String, onCancel: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(onClick = onCancel) {
            Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Назад", tint = KioskColors.TextSecondary)
        }
        Spacer(Modifier.width(4.dp))
        Column {
            Text("Меню", style = MaterialTheme.typography.titleLarge)
            Text(
                if (orderType == OrderType.HALL) "В зале" else "С собой",
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}

@Composable
private fun SearchField(value: String, onValueChange: (String) -> Unit) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
        placeholder = { Text("Поиск блюда") },
        singleLine = true,
        leadingIcon = { Icon(Icons.Outlined.Search, contentDescription = null, tint = KioskColors.TextTertiary) },
        trailingIcon = {
            if (value.isNotEmpty()) {
                IconButton(onClick = { onValueChange("") }) {
                    Icon(Icons.Outlined.Close, contentDescription = "Очистить", tint = KioskColors.TextTertiary)
                }
            }
        },
        shape = RoundedCornerShape(KioskRadius.pill),
        colors = OutlinedTextFieldDefaults.colors(
            focusedContainerColor = KioskColors.SurfaceMuted,
            unfocusedContainerColor = KioskColors.SurfaceMuted,
            focusedBorderColor = Color.Transparent,
            unfocusedBorderColor = Color.Transparent,
        ),
    )
}

@Composable
private fun CategoryRow(
    categories: List<com.restos.kiosk.data.menu.CategoryDto>,
    selectedId: String?,
    onSelect: (String?) -> Unit,
) {
    LazyRow(
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item {
            CategoryChip(label = "Всё", selected = selectedId == null, onClick = { onSelect(null) })
        }
        items(categories, key = { it.id }) { cat ->
            CategoryChip(label = cat.name, selected = selectedId == cat.id, onClick = { onSelect(cat.id) })
        }
    }
}

@Composable
private fun CategoryChip(label: String, selected: Boolean, onClick: () -> Unit) {
    Surface(
        shape = RoundedCornerShape(KioskRadius.pill),
        color = if (selected) KioskColors.Primary else KioskColors.Surface,
        border = if (selected) null else androidx.compose.foundation.BorderStroke(1.dp, KioskColors.Border),
        onClick = onClick,
    ) {
        Text(
            label,
            modifier = Modifier.padding(horizontal = 18.dp, vertical = 10.dp),
            fontSize = 14.sp,
            fontWeight = FontWeight.SemiBold,
            color = if (selected) KioskColors.OnPrimary else KioskColors.TextSecondary,
        )
    }
}

/**
 * Крупная карточка блюда, во всю ширину своей ячейки сетки. Все внутренние
 * блоки (фото, название, цена, кнопка) — фиксированной высоты, поэтому все
 * карточки в сетке ОДИНАКОВОЙ высоты независимо от длины названия (иначе
 * LazyVerticalGrid не растягивает соседей по высоте строки — короткая
 * карточка "плавает" мельче в той же строке).
 */
@Composable
private fun MenuItemCard(
    item: MenuItemDto,
    qtyInCart: Int,
    onAdd: () -> Unit,
    onIncrement: () -> Unit,
    onDecrement: () -> Unit,
) {
    Surface(
        shape = RoundedCornerShape(0.dp),
        color = KioskColors.Surface,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(modifier = Modifier.padding(10.dp)) {
            val dishBitmap = rememberDishImageBitmap(item.imageUrl)
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .aspectRatio(1f)
                    .background(KioskColors.SurfaceMuted, RoundedCornerShape(KioskRadius.tile))
                    .clip(RoundedCornerShape(KioskRadius.tile)),
                contentAlignment = Alignment.Center,
            ) {
                if (dishBitmap != null) {
                    Image(
                        bitmap = dishBitmap,
                        contentDescription = null,
                        contentScale = ContentScale.Crop,
                        modifier = Modifier.fillMaxSize(),
                    )
                } else {
                    // Без фото — название блюда вместо эмодзи (как на вебе,
                    // components/dish-image.tsx: эмодзи там deprecated).
                    Text(
                        item.name,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = KioskColors.TextSecondary,
                        textAlign = TextAlign.Center,
                        maxLines = 3,
                        modifier = Modifier.padding(10.dp),
                    )
                }
            }

            Spacer(Modifier.height(10.dp))
            // Высота под РОВНО 2 строки — 1-строчные названия не "проседают"
            // карточку ниже соседей в той же строке сетки.
            Text(
                item.name,
                style = MaterialTheme.typography.titleMedium,
                maxLines = 2,
                modifier = Modifier.fillMaxWidth().heightIn(min = 44.dp),
            )
            Spacer(Modifier.height(2.dp))
            Text(
                formatSom(item.price),
                style = MaterialTheme.typography.bodyLarge,
                color = KioskColors.TextSecondary,
            )
            Spacer(Modifier.height(10.dp))

            if (qtyInCart == 0) {
                Button(
                    onClick = onAdd,
                    modifier = Modifier.fillMaxWidth().height(48.dp),
                    shape = RoundedCornerShape(KioskRadius.button),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = KioskColors.PrimarySoft,
                        contentColor = KioskColors.Primary,
                    ),
                ) {
                    Icon(Icons.Outlined.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("Добавить", fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                }
            } else {
                Row(
                    modifier = Modifier.fillMaxWidth().height(48.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    QtyButton(icon = Icons.Outlined.Remove, onClick = onDecrement)
                    Text(
                        qtyInCart.toString(),
                        fontSize = 18.sp,
                        fontWeight = FontWeight.Bold,
                        color = KioskColors.TextPrimary,
                    )
                    QtyButton(icon = Icons.Outlined.Add, onClick = onIncrement, filled = true)
                }
            }
        }
    }
}

@Composable
private fun QtyButton(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    onClick: () -> Unit,
    filled: Boolean = false,
) {
    Surface(
        modifier = Modifier.size(44.dp),
        shape = CircleShape,
        color = if (filled) KioskColors.Primary else KioskColors.SurfaceMuted,
        onClick = onClick,
    ) {
        Box(contentAlignment = Alignment.Center) {
            Icon(
                icon,
                contentDescription = null,
                tint = if (filled) KioskColors.OnPrimary else KioskColors.TextPrimary,
                modifier = Modifier.size(20.dp),
            )
        }
    }
}

@Composable
private fun CartBar(
    count: Int,
    total: BigDecimal,
    enabled: Boolean,
    onSubmit: () -> Unit,
) {
    Surface(
        color = KioskColors.Surface,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp, vertical = 14.dp)
                .systemBarsPadding(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Column {
                Text(
                    if (count == 0) "Корзина пуста" else "$count ${pluralPositions(count)}",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Text(
                    formatSom(total),
                    fontSize = 22.sp,
                    fontWeight = FontWeight.Bold,
                    color = KioskColors.TextPrimary,
                )
            }
            Button(
                onClick = onSubmit,
                enabled = enabled,
                modifier = Modifier.height(56.dp).width(200.dp),
                shape = RoundedCornerShape(KioskRadius.pill),
                colors = ButtonDefaults.buttonColors(
                    containerColor = KioskColors.Primary,
                    contentColor = KioskColors.OnPrimary,
                    disabledContainerColor = KioskColors.Primary.copy(alpha = 0.35f),
                    disabledContentColor = KioskColors.OnPrimary,
                ),
            ) {
                Text("Оформить", fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

/**
 * Превью заказа перед отправкой — гость видит позиции/количество/итог и
 * может поправить корзину, прежде чем заказ реально уйдёт на кассу+кухню.
 */
@Composable
private fun OrderPreviewSheet(
    cart: List<CartLine>,
    total: BigDecimal,
    busy: Boolean,
    onDismiss: () -> Unit,
    onIncrement: (String) -> Unit,
    onDecrement: (String) -> Unit,
    onRemove: (String) -> Unit,
    onConfirm: () -> Unit,
) {
    Box(
        modifier = Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.45f)),
        contentAlignment = Alignment.BottomCenter,
    ) {
        Surface(
            modifier = Modifier.fillMaxWidth().widthIn(max = 560.dp),
            shape = RoundedCornerShape(topStart = KioskRadius.card, topEnd = KioskRadius.card),
            color = KioskColors.Bg,
        ) {
            Column(modifier = Modifier.fillMaxWidth().systemBarsPadding().padding(bottom = 16.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 16.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("Ваш заказ", style = MaterialTheme.typography.headlineSmall)
                    IconButton(onClick = onDismiss, enabled = !busy) {
                        Icon(Icons.Outlined.Close, contentDescription = "Закрыть", tint = KioskColors.TextSecondary)
                    }
                }

                LazyColumn(
                    modifier = Modifier.fillMaxWidth().heightIn(max = 360.dp).padding(horizontal = 20.dp),
                ) {
                    items(cart, key = { it.menuItemId }) { line ->
                        PreviewLine(
                            line = line,
                            onIncrement = { onIncrement(line.menuItemId) },
                            onDecrement = { onDecrement(line.menuItemId) },
                            onRemove = { onRemove(line.menuItemId) },
                        )
                    }
                }

                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text("Итого", style = MaterialTheme.typography.titleLarge)
                    Text(formatSom(total), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                }

                Button(
                    onClick = onConfirm,
                    enabled = !busy && cart.isNotEmpty(),
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp).height(56.dp),
                    shape = RoundedCornerShape(KioskRadius.button),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = KioskColors.Primary,
                        contentColor = KioskColors.OnPrimary,
                    ),
                ) {
                    if (busy) {
                        CircularProgressIndicator(modifier = Modifier.size(20.dp), color = KioskColors.OnPrimary, strokeWidth = 2.dp)
                    } else {
                        Text("Подтвердить заказ", fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                    }
                }
            }
        }
    }
}

@Composable
private fun PreviewLine(
    line: CartLine,
    onIncrement: () -> Unit,
    onDecrement: () -> Unit,
    onRemove: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(line.name, style = MaterialTheme.typography.bodyLarge, maxLines = 2)
            Text(formatSom(line.lineTotal()), style = MaterialTheme.typography.bodyMedium, color = KioskColors.TextSecondary)
        }
        Spacer(Modifier.width(12.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (line.qty <= 1) {
                QtyButton(icon = Icons.Outlined.Close, onClick = onRemove)
            } else {
                QtyButton(icon = Icons.Outlined.Remove, onClick = onDecrement)
            }
            Text(
                line.qty.toString(),
                fontSize = 16.sp,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.widthIn(min = 32.dp),
                textAlign = TextAlign.Center,
            )
            QtyButton(icon = Icons.Outlined.Add, onClick = onIncrement, filled = true)
        }
    }
}

/**
 * Фото блюда хранится как base64 data-URI прямо в menu_items.image_url
 * (см. lib/queries/menu.ts::uploadDishImage — лимит 500КБ, без файлового
 * сервера/CDN). Декодируем один раз на item.id и переиспользуем битмап,
 * пока LazyVerticalGrid не пересоздаст composable за пределами viewport.
 */
@Composable
private fun rememberDishImageBitmap(dataUri: String?): ImageBitmap? {
    return remember(dataUri) {
        if (dataUri.isNullOrBlank() || !dataUri.startsWith("data:")) return@remember null
        val comma = dataUri.indexOf(',')
        if (comma < 0) return@remember null
        runCatching {
            val bytes = Base64.decode(dataUri.substring(comma + 1), Base64.DEFAULT)
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
        }.getOrNull()
    }
}

private fun pluralPositions(n: Int): String {
    val mod10 = n % 10
    val mod100 = n % 100
    return when {
        mod10 == 1 && mod100 != 11 -> "позиция"
        mod10 in 2..4 && mod100 !in 12..14 -> "позиции"
        else -> "позиций"
    }
}
