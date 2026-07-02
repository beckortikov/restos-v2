package com.restos.kds.ui.board

import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.restos.kds.data.KdsItemDto
import com.restos.kds.ui.theme.KdsColors
import kotlinx.coroutines.delay
import java.time.Duration
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private data class ColumnSpec(val status: String, val label: String, val color: androidx.compose.ui.graphics.Color, val soft: androidx.compose.ui.graphics.Color, val btn: String)

private val COLUMNS = listOf(
    ColumnSpec("pending", "Новые", KdsColors.New, KdsColors.NewSoft, "В ГОТОВКУ"),
    ColumnSpec("cooking", "Готовится", KdsColors.Cooking, KdsColors.CookingSoft, "ГОТОВО"),
    ColumnSpec("ready", "К выдаче", KdsColors.Ready, KdsColors.ReadySoft, "ВЫДАНО"),
)

private fun stationColor(s: String) = when (s) {
    "cold_kitchen" -> KdsColors.StCold
    "grill" -> KdsColors.StGrill
    "showcase", "bar" -> KdsColors.StFry
    else -> KdsColors.StHot
}

@Composable
fun KdsBoardScreen(vm: KdsBoardViewModel = hiltViewModel()) {
    val state by vm.state.collectAsStateWithLifecycle()

    // Тикающие «сейчас» — для таймеров и часов (раз в 15с).
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) { now = System.currentTimeMillis(); delay(15_000) }
    }

    // Баннер отмены — авто-скрытие через 4с.
    LaunchedEffect(state.cancelAlert) {
        if (state.cancelAlert != null) { delay(4000); vm.dismissCancelAlert() }
    }

    var showConfig by remember { mutableStateOf(false) }
    if (showConfig) {
        StationConfigDialog(
            current = state.stations,
            onDismiss = { showConfig = false },
            onApply = { vm.setStations(it); showConfig = false },
        )
    }

    Column(Modifier.fillMaxSize().background(KdsColors.Bg)) {
        TopBar(
            count = state.items.size, nowMs = now,
            soundOn = state.soundEnabled, onToggleSound = vm::toggleSound,
            onConfig = { showConfig = true },
        )
        if (state.cancelAlert != null) {
            Row(
                Modifier.fillMaxWidth().background(KdsColors.Urgent).padding(horizontal = 20.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("⚠ ${state.cancelAlert}", color = KdsColors.OnSolid, fontSize = 16.sp, fontWeight = FontWeight.Bold)
            }
        }
        when {
            state.loading -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                CircularProgressIndicator(color = KdsColors.New)
            }
            state.error != null -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                Text(state.error ?: "", color = KdsColors.Urgent, fontSize = 18.sp)
            }
            else -> Row(
                Modifier.fillMaxSize().padding(16.dp),
                horizontalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                for (col in COLUMNS) {
                    val colItems = state.items.filter { it.stationStatus == col.status }
                    BoardColumn(col, colItems, now, onAdvance = vm::advance, modifier = Modifier.weight(1f))
                }
            }
        }
    }
}

@Composable
private fun TopBar(count: Int, nowMs: Long, soundOn: Boolean, onToggleSound: () -> Unit, onConfig: () -> Unit) {
    val clock = remember(nowMs / 60000) {
        DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.systemDefault()).format(Instant.ofEpochMilli(nowMs))
    }
    Row(
        Modifier.fillMaxWidth().height(64.dp).background(KdsColors.Bar).padding(horizontal = 20.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("Кухня", color = KdsColors.TextHi, fontSize = 22.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.width(12.dp))
        Row(
            Modifier.clip(RoundedCornerShape(999.dp)).background(KdsColors.ReadySoft)
                .padding(horizontal = 12.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(9.dp).clip(RoundedCornerShape(999.dp)).background(KdsColors.Ready))
            Spacer(Modifier.width(6.dp))
            Text("В реальном времени", color = KdsColors.Ready, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
        }
        Spacer(Modifier.weight(1f))
        Text("$count блюд", color = KdsColors.TextMid, fontSize = 14.sp)
        Spacer(Modifier.width(16.dp))
        // Тумблер звука (системный сигнал на новое/отменённое блюдо).
        Text(
            if (soundOn) "🔊" else "🔇",
            fontSize = 22.sp,
            modifier = Modifier.clip(RoundedCornerShape(10.dp)).clickable { onToggleSound() }.padding(4.dp),
        )
        Spacer(Modifier.width(12.dp))
        Text(
            "⚙",
            fontSize = 22.sp,
            modifier = Modifier.clip(RoundedCornerShape(10.dp)).clickable { onConfig() }.padding(4.dp),
        )
        Spacer(Modifier.width(16.dp))
        Text(clock, color = KdsColors.TextHi, fontSize = 22.sp, fontWeight = FontWeight.Bold)
    }
}

private val ALL_STATIONS = listOf(
    "hot_kitchen" to "Горячий цех",
    "cold_kitchen" to "Холодный цех",
    "grill" to "Гриль",
    "bar" to "Бар",
    "showcase" to "Витрина",
)

@Composable
private fun StationConfigDialog(current: List<String>, onDismiss: () -> Unit, onApply: (List<String>) -> Unit) {
    // Пусто = все выбраны.
    val selected = remember {
        androidx.compose.runtime.mutableStateListOf<String>().apply {
            addAll(if (current.isEmpty()) ALL_STATIONS.map { it.first } else current)
        }
    }
    androidx.compose.material3.AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = KdsColors.Card,
        title = { Text("Станции на этом экране", color = KdsColors.TextHi, fontWeight = FontWeight.Bold) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                for ((key, label) in ALL_STATIONS) {
                    val on = key in selected
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp))
                            .clickable { if (on) selected.remove(key) else selected.add(key) }
                            .padding(vertical = 12.dp, horizontal = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(if (on) "☑" else "☐", fontSize = 20.sp, color = if (on) KdsColors.New else KdsColors.TextDim)
                        Spacer(Modifier.width(12.dp))
                        Text(label, color = KdsColors.TextHi, fontSize = 16.sp)
                    }
                }
            }
        },
        confirmButton = {
            androidx.compose.material3.TextButton(onClick = {
                // Все выбраны → сохраняем пусто (= все).
                val all = selected.size == ALL_STATIONS.size
                onApply(if (all) emptyList() else selected.toList())
            }) { Text("Применить", color = KdsColors.New, fontWeight = FontWeight.Bold) }
        },
        dismissButton = {
            androidx.compose.material3.TextButton(onClick = onDismiss) { Text("Отмена", color = KdsColors.TextMid) }
        },
    )
}

@Composable
private fun BoardColumn(
    col: ColumnSpec,
    items: List<KdsItemDto>,
    nowMs: Long,
    onAdvance: (KdsItemDto) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier.fillMaxSize().clip(RoundedCornerShape(18.dp)).background(KdsColors.ColBg)
            .border(1.dp, KdsColors.CardLine, RoundedCornerShape(18.dp)),
    ) {
        Row(
            Modifier.fillMaxWidth().height(52.dp).background(col.soft).padding(horizontal = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(12.dp).clip(RoundedCornerShape(999.dp)).background(col.color))
            Spacer(Modifier.width(10.dp))
            Text(col.label, color = KdsColors.TextHi, fontSize = 18.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.weight(1f))
            Box(
                Modifier.clip(RoundedCornerShape(999.dp)).background(col.color).padding(horizontal = 12.dp, vertical = 3.dp),
            ) { Text("${items.size}", color = KdsColors.OnSolid, fontSize = 14.sp, fontWeight = FontWeight.Bold) }
        }
        LazyColumn(
            Modifier.fillMaxSize().padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            contentPadding = PaddingValues(bottom = 12.dp),
        ) {
            items(items, key = { it.id }) { item ->
                DishCard(item, col, nowMs, onAdvance)
            }
        }
    }
}

@Composable
private fun DishCard(item: KdsItemDto, col: ColumnSpec, nowMs: Long, onAdvance: (KdsItemDto) -> Unit) {
    val mins = minutesSince(item.createdAt, nowMs)
    val urgent = mins != null && mins >= 20
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(KdsColors.Card)
            .border(if (urgent) 2.dp else 1.dp, if (urgent) KdsColors.Urgent else KdsColors.CardLine, RoundedCornerShape(18.dp)),
    ) {
        Box(Modifier.fillMaxWidth().height(6.dp).background(col.color))
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            // Название + крупное количество.
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(item.name, color = KdsColors.TextHi, fontSize = 21.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                Spacer(Modifier.width(10.dp))
                Box(
                    Modifier.clip(RoundedCornerShape(10.dp)).background(col.color).padding(horizontal = 14.dp, vertical = 6.dp),
                ) { Text("×${item.qty}", color = KdsColors.OnSolid, fontSize = 26.sp, fontWeight = FontWeight.Black) }
            }
            // Комментарий.
            if (!item.comment.isNullOrBlank()) {
                Box(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(KdsColors.CookingSoft).padding(horizontal = 10.dp, vertical = 8.dp),
                ) { Text("💬 ${item.comment}", color = KdsColors.Cooking, fontSize = 14.sp, fontWeight = FontWeight.SemiBold) }
            }
            // Станция + заказ + таймер.
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(10.dp).clip(RoundedCornerShape(999.dp)).background(stationColor(item.station)))
                Spacer(Modifier.width(8.dp))
                Text(orderLabel(item), color = KdsColors.TextMid, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.weight(1f))
                if (mins != null) {
                    Text(
                        if (col.status == "ready") "готов" else "$mins мин",
                        color = if (urgent) KdsColors.Urgent else KdsColors.TextMid,
                        fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
                    )
                }
            }
            // Крупная кнопка-бамп.
            Box(
                Modifier.fillMaxWidth().height(60.dp).clip(RoundedCornerShape(14.dp)).background(col.color)
                    .clickable { onAdvance(item) },
                contentAlignment = Alignment.Center,
            ) { Text(col.btn, color = KdsColors.OnSolid, fontSize = 20.sp, fontWeight = FontWeight.Black) }
        }
    }
}

private fun orderLabel(item: KdsItemDto): String {
    val place = when {
        item.tableNumber != null -> "Стол ${item.tableNumber}"
        !item.tableName.isNullOrBlank() -> item.tableName!!
        item.orderType == "takeaway" -> "С собой"
        item.orderType == "delivery" -> "Доставка"
        else -> "Зал"
    }
    return "$place · #${item.orderNumber}"
}

private fun minutesSince(iso: String, nowMs: Long): Long? {
    if (iso.isBlank()) return null
    val instant = runCatching { OffsetDateTime.parse(iso).toInstant() }
        .recoverCatching { Instant.parse(iso) }
        .getOrNull() ?: return null
    return Duration.between(instant, Instant.ofEpochMilli(nowMs)).toMinutes().coerceAtLeast(0)
}

@Suppress("unused")
private val strikethrough = TextDecoration.LineThrough
