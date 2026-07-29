package com.restos.kds.ui.stoplist

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.restos.kds.data.MenuItemDto
import com.restos.kds.ui.theme.KdsColors

/**
 * Экран «Стоп-лист» на кухне: повар отмечает, что блюдо закончилось, — и касса
 * с официантами больше не могут его пробить.
 */
@Composable
fun KdsStopListDialog(onDismiss: () -> Unit, vm: KdsStopListViewModel = hiltViewModel()) {
    val s by vm.state.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { vm.load() }

    val visible = remember(s.items, s.query) {
        val q = s.query.trim()
        if (q.isBlank()) s.items
        else s.items.filter { it.name?.contains(q, ignoreCase = true) == true }
    }
    val grouped = remember(visible) {
        visible.groupBy { it.category?.takeIf { c -> c.isNotBlank() } ?: "Без категории" }
    }
    val stoppedCount = remember(s.items) { s.items.count { it.stopped } }

    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Column(
            Modifier.fillMaxWidth(0.92f).fillMaxHeight(0.92f)
                .clip(RoundedCornerShape(20.dp)).background(KdsColors.Card).padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            // Шапка.
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("Стоп-лист", color = KdsColors.TextHi, fontSize = 22.sp, fontWeight = FontWeight.Bold)
                Spacer(Modifier.width(12.dp))
                Text(
                    if (stoppedCount > 0) "в стопе: $stoppedCount" else "всё в наличии",
                    color = if (stoppedCount > 0) KdsColors.Urgent else KdsColors.Ready,
                    fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
                )
                Spacer(Modifier.weight(1f))
                Box(
                    Modifier.clip(RoundedCornerShape(10.dp)).background(KdsColors.ColBg)
                        .clickable { onDismiss() }.padding(horizontal = 16.dp, vertical = 8.dp),
                ) { Text("Закрыть", color = KdsColors.TextHi, fontSize = 15.sp, fontWeight = FontWeight.SemiBold) }
            }
            Text(
                "Отметьте, что закончилось — касса и официанты не смогут это пробить.",
                color = KdsColors.TextMid, fontSize = 13.sp,
            )

            OutlinedTextField(
                value = s.query, onValueChange = vm::setQuery,
                label = { Text("Поиск блюда", color = KdsColors.TextMid) },
                singleLine = true,
                colors = TextFieldDefaults.colors(
                    focusedContainerColor = KdsColors.ColBg,
                    unfocusedContainerColor = KdsColors.ColBg,
                    focusedTextColor = KdsColors.TextHi,
                    unfocusedTextColor = KdsColors.TextHi,
                    cursorColor = KdsColors.New,
                ),
                modifier = Modifier.fillMaxWidth(),
            )

            if (s.error != null) {
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(KdsColors.Urgent)
                        .clickable { vm.dismissError() }.padding(horizontal = 12.dp, vertical = 8.dp),
                ) { Text("⚠ ${s.error}", color = KdsColors.OnSolid, fontSize = 14.sp, fontWeight = FontWeight.SemiBold) }
            }

            when {
                s.loading -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                    CircularProgressIndicator(color = KdsColors.New)
                }
                visible.isEmpty() -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                    Text("Блюд не найдено", color = KdsColors.TextMid, fontSize = 16.sp)
                }
                else -> LazyColumn(
                    Modifier.fillMaxSize(),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    grouped.forEach { (category, list) ->
                        item(key = "cat-$category") {
                            Text(
                                category.uppercase(),
                                color = KdsColors.TextDim, fontSize = 12.sp, fontWeight = FontWeight.Bold,
                                modifier = Modifier.padding(top = 8.dp, bottom = 2.dp),
                            )
                        }
                        items(list, key = { it.id }) { item ->
                            DishStopRow(
                                item = item,
                                busy = item.id in s.busy,
                                onToggle = { vm.toggle(item) },
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun DishStopRow(item: MenuItemDto, busy: Boolean, onToggle: () -> Unit) {
    // Стоп «галочкой» в меню кухня снять не может — показываем, но не даём тапать.
    val menuStopped = item.isAvailable == false
    val stopped = item.stopped
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp))
            .background(if (stopped) KdsColors.CancelledCard else KdsColors.ColBg)
            .border(
                1.dp,
                if (stopped) KdsColors.Urgent else KdsColors.CardLine,
                RoundedCornerShape(10.dp),
            )
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (!item.emoji.isNullOrBlank()) {
            Text(item.emoji, fontSize = 18.sp)
            Spacer(Modifier.width(8.dp))
        }
        Text(
            item.name ?: "—",
            color = KdsColors.TextHi, fontSize = 16.sp, fontWeight = FontWeight.SemiBold,
            maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (menuStopped) {
            Text("стоп в меню", color = KdsColors.TextDim, fontSize = 12.sp)
            Spacer(Modifier.width(10.dp))
        }
        Box(
            Modifier.width(132.dp).height(44.dp).clip(RoundedCornerShape(10.dp))
                .background(
                    when {
                        busy -> KdsColors.TextDim
                        stopped -> KdsColors.Urgent
                        else -> KdsColors.Ready
                    },
                )
                .clickable(enabled = !busy && !menuStopped, onClick = onToggle),
            contentAlignment = Alignment.Center,
        ) {
            if (busy) {
                CircularProgressIndicator(
                    color = KdsColors.OnSolid, strokeWidth = 2.dp,
                    modifier = Modifier.height(18.dp).width(18.dp),
                )
            } else {
                Text(
                    if (stopped) "ЗАКОНЧИЛОСЬ" else "ЕСТЬ",
                    color = KdsColors.OnSolid, fontSize = 13.sp, fontWeight = FontWeight.Black,
                )
            }
        }
    }
}
