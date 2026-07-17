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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
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

    // Баннер отмены — держим ~6с, чтобы повар успел прочитать блюдо и заказ.
    LaunchedEffect(state.cancelAlert) {
        if (state.cancelAlert != null) { delay(6000); vm.dismissCancelAlert() }
    }

    // Фуллскрин-фокус: прячем топбар, колонки занимают весь экран (больше видно).
    var fullscreen by remember { mutableStateOf(false) }
    ImmersiveEffect(fullscreen)

    var showStopList by remember { mutableStateOf(false) }
    if (showStopList) {
        com.restos.kds.ui.stoplist.KdsStopListDialog(onDismiss = { showStopList = false })
    }

    var showConfig by remember { mutableStateOf(false) }
    if (showConfig) {
        StationConfigDialog(
            current = state.stations,
            available = state.availableStations,
            soundId = state.soundId,
            soundNames = vm.soundNames,
            onPickSound = { vm.setSoundId(it); vm.previewSound(it) },
            onDismiss = { showConfig = false },
            onApply = { vm.setStations(it); showConfig = false },
        )
    }

    Box(Modifier.fillMaxSize().background(KdsColors.Bg)) {
        Column(Modifier.fillMaxSize()) {
            if (!fullscreen) {
                TopBar(
                    count = state.items.size + state.cancelledItems.size, nowMs = now,
                    soundOn = state.soundEnabled, onToggleSound = vm::toggleSound,
                    onStopList = { showStopList = true },
                    onConfig = { showConfig = true },
                    onFullscreen = { fullscreen = true },
                )
            }
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
                    // В фуллскрине — минимум полей, колонки на всю высоту/ширину.
                    Modifier.fillMaxSize().padding(if (fullscreen) 6.dp else 14.dp),
                    horizontalArrangement = Arrangement.spacedBy(if (fullscreen) 6.dp else 12.dp),
                ) {
                    for (col in COLUMNS) {
                        // Отменённые блюда — сверху «Новых», отдельными карточками.
                        val base = state.items.filter { it.stationStatus == col.status }
                        val colItems = if (col.status == "pending") state.cancelledItems + base else base
                        BoardColumn(
                            col, colItems, now, state.fetchedAtMs,
                            onAdvance = vm::advance, onClose = vm::closeCancelled,
                            calledIds = state.calledItems, onCallWaiter = vm::callWaiter,
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
            }
        }
        // Выход из фуллскрина — плавающая кнопка в углу.
        if (fullscreen) {
            Box(
                Modifier.align(Alignment.TopEnd).padding(10.dp)
                    .clip(RoundedCornerShape(12.dp)).background(KdsColors.Bar)
                    .clickable { fullscreen = false }
                    .padding(horizontal = 14.dp, vertical = 8.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text("⛶ Свернуть", color = KdsColors.TextHi, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

/**
 * Пере-прячет системные панели (иногда возвращаются после диалогов/шторки),
 * особенно при входе в фуллскрин-режим. Работает поверх киоск-режима Activity.
 */
@Composable
private fun ImmersiveEffect(fullscreen: Boolean) {
    val view = androidx.compose.ui.platform.LocalView.current
    LaunchedEffect(fullscreen) {
        val window = (view.context as? android.app.Activity)?.window ?: return@LaunchedEffect
        runCatching {
            val controller = androidx.core.view.WindowInsetsControllerCompat(window, window.decorView)
            controller.hide(androidx.core.view.WindowInsetsCompat.Type.systemBars())
            controller.systemBarsBehavior =
                androidx.core.view.WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }
}

@Composable
private fun TopBar(
    count: Int,
    nowMs: Long,
    soundOn: Boolean,
    onToggleSound: () -> Unit,
    onStopList: () -> Unit,
    onConfig: () -> Unit,
    onFullscreen: () -> Unit,
) {
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
        // Стоп-лист — повар отмечает, что закончилось (касса/официант не пробьют).
        Box(
            Modifier.clip(RoundedCornerShape(10.dp)).background(KdsColors.ColBg)
                .clickable { onStopList() }.padding(horizontal = 12.dp, vertical = 6.dp),
        ) {
            Text("СТОП-ЛИСТ", color = KdsColors.TextHi, fontSize = 13.sp, fontWeight = FontWeight.Bold)
        }
        Spacer(Modifier.width(12.dp))
        Text(
            "⚙",
            fontSize = 22.sp,
            modifier = Modifier.clip(RoundedCornerShape(10.dp)).clickable { onConfig() }.padding(4.dp),
        )
        Spacer(Modifier.width(12.dp))
        // Фуллскрин — прячет топбар, колонки на весь экран.
        Text(
            "⛶",
            fontSize = 22.sp,
            color = KdsColors.TextHi,
            modifier = Modifier.clip(RoundedCornerShape(10.dp)).clickable { onFullscreen() }.padding(4.dp),
        )
        Spacer(Modifier.width(16.dp))
        Text(clock, color = KdsColors.TextHi, fontSize = 22.sp, fontWeight = FontWeight.Bold)
    }
}

private val STATION_LABELS = mapOf(
    "hot_kitchen" to "Горячий цех",
    "cold_kitchen" to "Холодный цех",
    "grill" to "Гриль",
    "bar" to "Бар",
    "showcase" to "Витрина",
    "kitchen" to "Кухня",
)

private fun stationLabel(key: String) = STATION_LABELS[key] ?: key

@Composable
private fun StationConfigDialog(
    current: List<String>,
    available: List<String>,
    soundId: Int,
    soundNames: List<String>,
    onPickSound: (Int) -> Unit,
    onDismiss: () -> Unit,
    onApply: (List<String>) -> Unit,
) {
    // Пусто current = все выбраны.
    val selected = remember(available) {
        androidx.compose.runtime.mutableStateListOf<String>().apply {
            addAll(if (current.isEmpty()) available else current)
        }
    }
    androidx.compose.material3.AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = KdsColors.Card,
        title = { Text("Настройки дисплея", color = KdsColors.TextHi, fontWeight = FontWeight.Bold) },
        text = {
            Column(
                verticalArrangement = Arrangement.spacedBy(4.dp),
                modifier = Modifier.verticalScroll(rememberScrollState()),
            ) {
                // ─── Звук сигнала (громкий, на выбор) ───
                Text("Звук нового блюда", color = KdsColors.TextMid, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                soundNames.forEachIndexed { idx, name ->
                    val on = idx == soundId
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp))
                            .clickable { onPickSound(idx) }
                            .padding(vertical = 10.dp, horizontal = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(if (on) "◉" else "○", fontSize = 20.sp, color = if (on) KdsColors.New else KdsColors.TextDim)
                        Spacer(Modifier.width(12.dp))
                        Text(name, color = KdsColors.TextHi, fontSize = 16.sp, modifier = Modifier.weight(1f))
                        Text("▶", fontSize = 16.sp, color = KdsColors.TextMid)
                    }
                }

                Spacer(Modifier.height(8.dp))
                Text("Станции на этом экране", color = KdsColors.TextMid, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                if (available.isEmpty()) {
                    Text("Станции не загружены (нет связи с кассой).", color = KdsColors.TextMid, fontSize = 14.sp)
                } else {
                    for (key in available) {
                        val on = key in selected
                        Row(
                            Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp))
                                .clickable { if (on) selected.remove(key) else selected.add(key) }
                                .padding(vertical = 12.dp, horizontal = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(if (on) "☑" else "☐", fontSize = 20.sp, color = if (on) KdsColors.New else KdsColors.TextDim)
                            Spacer(Modifier.width(12.dp))
                            Text(stationLabel(key), color = KdsColors.TextHi, fontSize = 16.sp)
                        }
                    }
                }
            }
        },
        confirmButton = {
            androidx.compose.material3.TextButton(onClick = {
                // Все доступные выбраны → сохраняем пусто (= все).
                val all = available.isNotEmpty() && selected.size == available.size
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
    fetchedAtMs: Long,
    onAdvance: (KdsItemDto) -> Unit,
    onClose: (String) -> Unit,
    calledIds: Set<String>,
    onCallWaiter: (KdsItemDto) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier.fillMaxSize().clip(RoundedCornerShape(18.dp)).background(KdsColors.ColBg)
            .border(1.dp, KdsColors.CardLine, RoundedCornerShape(18.dp)),
    ) {
        Row(
            Modifier.fillMaxWidth().height(42.dp).background(col.soft).padding(horizontal = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(11.dp).clip(RoundedCornerShape(999.dp)).background(col.color))
            Spacer(Modifier.width(8.dp))
            Text(col.label, color = KdsColors.TextHi, fontSize = 16.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.weight(1f))
            Box(
                Modifier.clip(RoundedCornerShape(999.dp)).background(col.color).padding(horizontal = 11.dp, vertical = 2.dp),
            ) { Text("${items.size}", color = KdsColors.OnSolid, fontSize = 14.sp, fontWeight = FontWeight.Bold) }
        }
        LazyColumn(
            Modifier.fillMaxSize().padding(horizontal = 8.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
            contentPadding = PaddingValues(bottom = 8.dp),
        ) {
            items(items, key = { it.id }) { item ->
                DishCard(item, col, nowMs, fetchedAtMs, onAdvance, onClose, item.id in calledIds, onCallWaiter)
            }
        }
    }
}

@Composable
private fun DishCard(
    item: KdsItemDto,
    col: ColumnSpec,
    nowMs: Long,
    fetchedAtMs: Long,
    onAdvance: (KdsItemDto) -> Unit,
    onClose: (String) -> Unit,
    called: Boolean,
    onCallWaiter: (KdsItemDto) -> Unit,
) {
    val cancelled = item.cancelled
    val mins = elapsedMinutes(item, nowMs, fetchedAtMs)
    val urgent = !cancelled && mins != null && mins >= 20
    // Отменённая карточка — красный акцент, статичная (повар только закрывает).
    val accent = if (cancelled) KdsColors.Urgent else col.color
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp))
            .background(if (cancelled) KdsColors.CancelledCard else KdsColors.Card)
            .border(
                if (cancelled || urgent) 2.dp else 1.dp,
                if (cancelled || urgent) KdsColors.Urgent else KdsColors.CardLine,
                RoundedCornerShape(14.dp),
            ),
    ) {
        Box(Modifier.fillMaxWidth().height(4.dp).background(accent))
        // Компактная карточка — влезает максимум заказов на экран.
        Column(Modifier.padding(horizontal = 10.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            // Плашка «ОТМЕНЕНО».
            if (cancelled) {
                Box(
                    Modifier.clip(RoundedCornerShape(6.dp)).background(KdsColors.Urgent)
                        .padding(horizontal = 8.dp, vertical = 2.dp),
                ) { Text("ОТМЕНЕНО", color = KdsColors.OnSolid, fontSize = 12.sp, fontWeight = FontWeight.Black) }
            }
            // Название + вызов официанта + крупное количество.
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    item.name, color = KdsColors.TextHi, fontSize = 18.sp, fontWeight = FontWeight.Bold,
                    textDecoration = if (cancelled) TextDecoration.LineThrough else null,
                    maxLines = 2, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                // Колокольчик — позвать официанта заказа на кухню.
                if (!cancelled && !item.waiterName.isNullOrBlank()) {
                    Spacer(Modifier.width(8.dp))
                    Box(
                        Modifier.clip(RoundedCornerShape(10.dp))
                            .background(if (called) KdsColors.Ready else KdsColors.ColBg)
                            .clickable(enabled = !called) { onCallWaiter(item) }
                            .padding(horizontal = 10.dp, vertical = 7.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            if (called) "✓ Вызван" else "🔔",
                            color = if (called) KdsColors.OnSolid else KdsColors.TextHi,
                            fontSize = 15.sp, fontWeight = FontWeight.Bold,
                        )
                    }
                }
                Spacer(Modifier.width(8.dp))
                Box(
                    Modifier.clip(RoundedCornerShape(8.dp)).background(accent).padding(horizontal = 10.dp, vertical = 3.dp),
                ) { Text(qtyLabel(item), color = KdsColors.OnSolid, fontSize = 20.sp, fontWeight = FontWeight.Black) }
            }
            // Комментарий.
            if (!item.comment.isNullOrBlank()) {
                Box(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(6.dp)).background(KdsColors.CookingSoft).padding(horizontal = 8.dp, vertical = 5.dp),
                ) { Text("💬 ${item.comment}", color = KdsColors.Cooking, fontSize = 13.sp, fontWeight = FontWeight.SemiBold) }
            }
            // Станция + заказ + официант + таймер — одной строкой (экономим высоту).
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(9.dp).clip(RoundedCornerShape(999.dp)).background(stationColor(item.station)))
                Spacer(Modifier.width(7.dp))
                Text(
                    orderLabel(item) + (item.waiterName?.takeIf { it.isNotBlank() }?.let { " · 👤 $it" } ?: ""),
                    color = KdsColors.TextMid, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                    maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (!cancelled && mins != null) {
                    Spacer(Modifier.width(6.dp))
                    Text(
                        if (col.status == "ready") "готов" else "$mins мин",
                        color = if (urgent) KdsColors.Urgent else KdsColors.TextMid,
                        fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                    )
                }
            }
            // Кнопка-бамп: обычная двигает статус, отменённая — «ЗАКРЫТЬ».
            Box(
                Modifier.fillMaxWidth().height(46.dp).clip(RoundedCornerShape(11.dp))
                    .background(if (cancelled) KdsColors.Urgent else col.color)
                    .clickable { if (cancelled) onClose(item.id) else onAdvance(item) },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    if (cancelled) "ЗАКРЫТЬ" else col.btn,
                    color = KdsColors.OnSolid, fontSize = 16.sp, fontWeight = FontWeight.Black,
                )
            }
        }
    }
}

/**
 * Количество на карточке. Весовое блюдо (unit g/kg) → «100 г» / «1.5 кг»
 * (qty = вес), чтобы повар не читал это как «×100 порций». Штучное → «×2».
 */
private fun qtyLabel(item: KdsItemDto): String {
    val q = trimQty(item.qty)
    return when (item.unit?.lowercase()) {
        "g" -> "$q г"
        "kg" -> "$q кг"
        else -> "×$q"
    }
}

/** Убирает хвостовые нули у decimal-строки: "100.0000"→"100", "1.5000"→"1.5". */
private fun trimQty(q: String): String =
    if (q.contains('.')) q.trimEnd('0').trimEnd('.') else q

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

/**
 * Сколько минут прошло с поступления блюда. Основа — серверный `ageSeconds`
 * (часы КАССЫ, а не планшета) плюс время, прошедшее с момента загрузки списка.
 * Дельта считается по одним и тем же часам планшета, поэтому кривой абсолютный
 * сдвиг часов кухонного планшета не важен. Фолбэк на created_at — только для
 * старой кассы, которая ещё не присылает ageSeconds.
 */
private fun elapsedMinutes(item: KdsItemDto, nowMs: Long, fetchedAtMs: Long): Long? {
    val age = item.ageSeconds
    if (age != null) {
        val sinceFetch = if (fetchedAtMs > 0) ((nowMs - fetchedAtMs) / 1000).coerceAtLeast(0) else 0
        return ((age + sinceFetch) / 60).coerceAtLeast(0)
    }
    return minutesSince(item.createdAt, nowMs)
}

private fun minutesSince(iso: String, nowMs: Long): Long? {
    if (iso.isBlank()) return null
    val instant = runCatching { OffsetDateTime.parse(iso).toInstant() }
        .recoverCatching { Instant.parse(iso) }
        .getOrNull() ?: return null
    return Duration.between(instant, Instant.ofEpochMilli(nowMs)).toMinutes().coerceAtLeast(0)
}
