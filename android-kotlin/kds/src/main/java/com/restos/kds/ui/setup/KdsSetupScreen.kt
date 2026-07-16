package com.restos.kds.ui.setup

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.google.accompanist.permissions.ExperimentalPermissionsApi
import com.google.accompanist.permissions.isGranted
import com.google.accompanist.permissions.rememberPermissionState
import com.restos.core.onboarding.QrScannerView
import com.restos.kds.ui.theme.KdsColors

@OptIn(ExperimentalPermissionsApi::class)
@Composable
fun KdsSetupScreen(vm: KdsSetupViewModel = hiltViewModel(), onDone: () -> Unit) {
    val s by vm.state.collectAsStateWithLifecycle()
    val camPermission = rememberPermissionState(android.Manifest.permission.CAMERA)

    Box(Modifier.fillMaxSize().background(KdsColors.Bg), Alignment.Center) {
        Column(
            Modifier.width(480.dp).clip(RoundedCornerShape(20.dp)).background(KdsColors.Card)
                .verticalScroll(rememberScrollState()).padding(28.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            if (!s.connected) {
                // ─── Онбординг: привязка к кассе (QR / адрес) ───
                Text(
                    "RestOS Кухня", color = KdsColors.TextHi, fontSize = 26.sp,
                    fontWeight = FontWeight.Bold, modifier = Modifier.fillMaxWidth(),
                )
                Text("Наведите на QR-код кассы или введите адрес", color = KdsColors.TextMid, fontSize = 14.sp)

                val colors = TextFieldDefaults.colors(
                    focusedContainerColor = KdsColors.ColBg,
                    unfocusedContainerColor = KdsColors.ColBg,
                    focusedTextColor = KdsColors.TextHi,
                    unfocusedTextColor = KdsColors.TextHi,
                    cursorColor = KdsColors.New,
                )

                // Сканер QR (как у официанта) — камера кассового QR.
                Box(
                    Modifier.fillMaxWidth().aspectRatio(1.4f).clip(RoundedCornerShape(14.dp)).background(KdsColors.ColBg),
                    contentAlignment = Alignment.Center,
                ) {
                    if (camPermission.status.isGranted) {
                        QrScannerView(modifier = Modifier.fillMaxSize(), onResult = vm::onQrScanned)
                    } else {
                        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            Text("📷", fontSize = 40.sp)
                            PrimaryButton("Разрешить камеру", busy = false) { camPermission.launchPermissionRequest() }
                        }
                    }
                }

                OutlinedTextField(
                    value = s.url, onValueChange = vm::setUrl,
                    label = { Text("Адрес кассы (http://ip:3001/)", color = KdsColors.TextMid) },
                    singleLine = true, colors = colors, modifier = Modifier.fillMaxWidth(),
                )
                if (s.error != null) Text(s.error!!, color = KdsColors.Urgent, fontSize = 14.sp)
                PrimaryButton("Подключиться", busy = s.busy) { vm.connect() }
            } else {
                // ─── Вход по PIN (касса привязана) — красивый PIN-пад как у официанта ───
                Text("RestOS Кухня", color = KdsColors.TextHi, fontSize = 24.sp, fontWeight = FontWeight.Bold)
                Text(
                    "Касса: ${s.restaurantName ?: "подключена"}",
                    color = KdsColors.Ready, fontSize = 15.sp, fontWeight = FontWeight.SemiBold,
                )
                Text("Введите PIN повара", color = KdsColors.TextMid, fontSize = 14.sp)

                Spacer(Modifier.height(4.dp))
                PinDots(length = s.pin.length, max = KdsSetupViewModel.MAX_PIN)

                // Фиксированная строка под ошибку — чтобы пад не «прыгал».
                Box(Modifier.fillMaxWidth().height(22.dp), contentAlignment = Alignment.Center) {
                    if (s.error != null) Text(s.error!!, color = KdsColors.Urgent, fontSize = 14.sp)
                }

                Keypad(enabled = !s.busy, onDigit = vm::appendDigit, onBackspace = vm::backspace)

                PrimaryButton(
                    "Войти",
                    busy = s.busy,
                    enabled = s.pin.length >= KdsSetupViewModel.MIN_PIN,
                ) { vm.login(onDone) }
                Text(
                    "← Сменить кассу",
                    color = KdsColors.TextMid, fontSize = 13.sp,
                    modifier = Modifier.clickable { vm.reset() }.padding(4.dp),
                )
            }
        }
    }
}

/** Точки-индикаторы введённых цифр PIN (как у официанта). */
@Composable
private fun PinDots(length: Int, max: Int) {
    Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        repeat(max) { i ->
            val filled = i < length
            Box(
                Modifier.size(18.dp).clip(RoundedCornerShape(999.dp))
                    .background(if (filled) KdsColors.New else KdsColors.ColBg)
                    .then(
                        if (filled) Modifier
                        else Modifier.border(1.5.dp, KdsColors.CardLine, RoundedCornerShape(999.dp)),
                    ),
            )
        }
    }
}

/** Цифровая клавиатура 3×3 + [·, 0, ⌫]. */
@Composable
private fun Keypad(enabled: Boolean, onDigit: (Char) -> Unit, onBackspace: () -> Unit) {
    val rows = listOf("123", "456", "789")
    Column(
        Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        rows.forEach { row ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                row.forEach { c -> KeyButton(c.toString(), Modifier.weight(1f), enabled) { onDigit(c) } }
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Spacer(Modifier.weight(1f))
            KeyButton("0", Modifier.weight(1f), enabled) { onDigit('0') }
            KeyButton("⌫", Modifier.weight(1f), enabled) { onBackspace() }
        }
    }
}

@Composable
private fun KeyButton(label: String, modifier: Modifier, enabled: Boolean, onClick: () -> Unit) {
    Box(
        modifier.aspectRatio(1.7f).clip(RoundedCornerShape(16.dp))
            .background(KdsColors.ColBg)
            .border(1.dp, KdsColors.CardLine, RoundedCornerShape(16.dp))
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, color = KdsColors.TextHi, fontSize = 26.sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun PrimaryButton(label: String, busy: Boolean, enabled: Boolean = true, onClick: () -> Unit) {
    val active = enabled && !busy
    Box(
        Modifier.fillMaxWidth().height(56.dp).clip(RoundedCornerShape(14.dp))
            .background(if (active) KdsColors.New else KdsColors.TextDim)
            .clickable(enabled = active, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        if (busy) CircularProgressIndicator(color = KdsColors.OnSolid, strokeWidth = 2.dp, modifier = Modifier.height(22.dp).width(22.dp))
        else Text(label, color = KdsColors.OnSolid, fontSize = 18.sp, fontWeight = FontWeight.Bold)
    }
}
