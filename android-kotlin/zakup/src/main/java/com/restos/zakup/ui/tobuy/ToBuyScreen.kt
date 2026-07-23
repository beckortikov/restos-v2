package com.restos.zakup.ui.tobuy

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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Circle
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.restos.zakup.ui.components.BadgeKind
import com.restos.zakup.ui.components.EmptyState
import com.restos.zakup.ui.components.ErrorState
import com.restos.zakup.ui.components.LoadingState
import com.restos.zakup.ui.components.StatusBadge
import com.restos.zakup.ui.components.ZakupCard
import com.restos.zakup.ui.components.ZakupTopBar
import com.restos.zakup.ui.theme.ZakupColors
import com.restos.zakup.ui.theme.ZakupRadius
import com.restos.zakup.util.formatQty

/** Экран 06 «Что закупить» — позиции ниже минимума + предложенный объём. */
@Composable
fun ToBuyScreen(
    onBack: () -> Unit,
    onCreateReceipt: (List<String>) -> Unit = {},
    viewModel: ToBuyViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        ZakupTopBar("Что закупить", onBack = onBack) {
            if (state.items.isNotEmpty()) {
                Surface(shape = RoundedCornerShape(ZakupRadius.badge), color = ZakupColors.WarnSoft) {
                    Text(
                        "${state.items.size}",
                        color = ZakupColors.Warn,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier.padding(horizontal = 9.dp, vertical = 4.dp),
                    )
                }
            }
        }

        when {
            state.loading -> LoadingState()
            state.error != null -> ErrorState(state.error!!, onRetry = viewModel::load)
            state.items.isEmpty() -> EmptyState("Все позиции выше минимума 👍")
            else -> Box(Modifier.weight(1f)) {
                LazyColumn(
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    item {
                        Surface(shape = RoundedCornerShape(ZakupRadius.tile), color = ZakupColors.WarnSoft, modifier = Modifier.fillMaxWidth()) {
                            Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                                Icon(Icons.Outlined.WarningAmber, contentDescription = null, tint = ZakupColors.WarnText, modifier = Modifier.size(18.dp))
                                Spacer(Modifier.size(8.dp))
                                Text(
                                    "${state.items.size} позиций ниже минимума. Проверьте объёмы.",
                                    fontSize = 13.sp,
                                    color = ZakupColors.WarnText,
                                )
                            }
                        }
                    }
                    items(state.items, key = { it.id }) { item ->
                        BuyRow(item, selected = item.id in state.selected, onToggle = { viewModel.toggleSelected(item.id) })
                    }
                    item { Spacer(Modifier.height(72.dp)) }
                }

                CreateReceiptBar(
                    count = state.selected.size,
                    onClick = { onCreateReceipt(state.selected.toList()) },
                    modifier = Modifier.align(Alignment.BottomCenter),
                )
            }
        }
    }
}

@Composable
private fun BuyRow(item: BuyItem, selected: Boolean, onToggle: () -> Unit) {
    ZakupCard(Modifier.fillMaxWidth().clickable(onClick = onToggle), padding = 14) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(
                if (selected) Icons.Filled.CheckCircle else Icons.Outlined.Circle,
                contentDescription = null,
                tint = if (selected) { if (item.isOut) ZakupColors.Danger else ZakupColors.Warn } else ZakupColors.Border,
                modifier = Modifier.size(22.dp),
            )
            Spacer(Modifier.size(10.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(item.name, style = MaterialTheme.typography.titleMedium)
                    Spacer(Modifier.size(8.dp))
                    if (item.isOut) StatusBadge("Нет", BadgeKind.Danger) else StatusBadge("Мало", BadgeKind.Warn)
                }
                Spacer(Modifier.size(2.dp))
                Text(
                    "Остаток ${formatQty(item.qty, null)} · мин ${formatQty(item.minQty, item.unit)}",
                    fontSize = 12.5.sp,
                    color = ZakupColors.TextTertiary,
                )
            }
            Column(horizontalAlignment = Alignment.End) {
                Text(formatQty(item.suggested, item.unit), fontSize = 16.sp, fontWeight = FontWeight.Bold, color = ZakupColors.Primary)
                Text("к закупке", fontSize = 11.sp, color = ZakupColors.TextTertiary)
            }
        }
    }
}

@Composable
private fun CreateReceiptBar(count: Int, onClick: () -> Unit, modifier: Modifier) {
    Surface(color = ZakupColors.Bg, modifier = modifier.fillMaxWidth()) {
        Box(Modifier.padding(20.dp).navigationBarsPadding()) {
            Surface(
                onClick = onClick,
                enabled = count > 0,
                shape = RoundedCornerShape(ZakupRadius.button),
                color = if (count > 0) ZakupColors.Primary else ZakupColors.Primary.copy(alpha = 0.4f),
                modifier = Modifier.fillMaxWidth().height(54.dp),
            ) {
                Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.Add, contentDescription = null, tint = ZakupColors.OnPrimary)
                    Spacer(Modifier.size(8.dp))
                    Text("Создать приёмку · $count поз.", color = ZakupColors.OnPrimary, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                }
            }
        }
    }
}
