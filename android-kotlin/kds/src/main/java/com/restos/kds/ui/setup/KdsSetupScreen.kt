package com.restos.kds.ui.setup

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
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
            Modifier.width(480.dp).clip(RoundedCornerShape(20.dp)).background(KdsColors.Card).padding(28.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text("RestOS Кухня", color = KdsColors.TextHi, fontSize = 26.sp, fontWeight = FontWeight.Bold)

            val colors = TextFieldDefaults.colors(
                focusedContainerColor = KdsColors.ColBg,
                unfocusedContainerColor = KdsColors.ColBg,
                focusedTextColor = KdsColors.TextHi,
                unfocusedTextColor = KdsColors.TextHi,
                cursorColor = KdsColors.New,
            )

            if (!s.connected) {
                Text("Наведите на QR-код кассы или введите адрес", color = KdsColors.TextMid, fontSize = 14.sp)

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
                Text(
                    "Касса: ${s.restaurantName ?: "подключена"}",
                    color = KdsColors.Ready, fontSize = 15.sp, fontWeight = FontWeight.SemiBold,
                )
                OutlinedTextField(
                    value = s.pin, onValueChange = vm::setPin,
                    label = { Text("PIN повара", color = KdsColors.TextMid) },
                    singleLine = true, colors = colors,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                    modifier = Modifier.fillMaxWidth(),
                )
                if (s.error != null) Text(s.error!!, color = KdsColors.Urgent, fontSize = 14.sp)
                PrimaryButton("Войти", busy = s.busy) { vm.login(onDone) }
                Text(
                    "← Сменить кассу",
                    color = KdsColors.TextMid, fontSize = 13.sp,
                    modifier = Modifier.clickable { vm.reset() }.padding(4.dp),
                )
            }
        }
    }
}

@Composable
private fun PrimaryButton(label: String, busy: Boolean, onClick: () -> Unit) {
    Box(
        Modifier.fillMaxWidth().height(56.dp).clip(RoundedCornerShape(14.dp))
            .background(if (busy) KdsColors.TextDim else KdsColors.New)
            .clickable(enabled = !busy, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        if (busy) CircularProgressIndicator(color = KdsColors.OnSolid, strokeWidth = 2.dp, modifier = Modifier.height(22.dp).width(22.dp))
        else Text(label, color = KdsColors.OnSolid, fontSize = 18.sp, fontWeight = FontWeight.Bold)
    }
}
