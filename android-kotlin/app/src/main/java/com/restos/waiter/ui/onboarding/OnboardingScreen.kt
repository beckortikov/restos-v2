package com.restos.waiter.ui.onboarding

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material.icons.outlined.Wifi
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.google.accompanist.permissions.ExperimentalPermissionsApi
import com.google.accompanist.permissions.isGranted
import com.google.accompanist.permissions.rememberPermissionState

@OptIn(ExperimentalMaterial3Api::class, ExperimentalPermissionsApi::class)
@Composable
fun OnboardingScreen(
    onDone: () -> Unit,
    viewModel: OnboardingViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    var scannerVisible by remember { mutableStateOf(false) }
    val cameraPermission = rememberPermissionState(android.Manifest.permission.CAMERA)

    LaunchedEffect(state.done) {
        if (state.done) onDone()
    }

    Surface(
        modifier = Modifier.fillMaxSize(),
        color = MaterialTheme.colorScheme.background,
    ) {
        if (scannerVisible) {
            ScannerUI(
                onCancel = { scannerVisible = false },
                onCode = { code ->
                    scannerVisible = false
                    viewModel.onQrScanned(code)
                },
            )
            return@Surface
        }

        Column(
            modifier = Modifier
                .fillMaxSize()
                .systemBarsPadding()
                .padding(horizontal = 24.dp, vertical = 16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.height(32.dp))

            Icon(
                Icons.Outlined.Wifi,
                contentDescription = null,
                modifier = Modifier.size(56.dp),
                tint = MaterialTheme.colorScheme.primary,
            )
            Spacer(Modifier.height(16.dp))
            Text(
                "Подключение к ресторану",
                fontSize = 20.sp,
                fontWeight = FontWeight.SemiBold,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(8.dp))
            Text(
                "Отсканируйте QR с экрана кассы или введите адрес сервера вручную.",
                fontSize = 14.sp,
                textAlign = TextAlign.Center,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.65f),
            )

            Spacer(Modifier.height(32.dp))

            Button(
                onClick = {
                    if (cameraPermission.status.isGranted) {
                        scannerVisible = true
                    } else {
                        cameraPermission.launchPermissionRequest()
                    }
                },
                enabled = !state.testing,
                modifier = Modifier.fillMaxWidth().height(56.dp),
            ) {
                Icon(Icons.Outlined.QrCodeScanner, contentDescription = null)
                Spacer(Modifier.size(8.dp))
                Text("Сканировать QR", fontWeight = FontWeight.SemiBold)
            }

            Spacer(Modifier.height(24.dp))

            Text(
                "ИЛИ ВРУЧНУЮ",
                fontSize = 11.sp,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = 0.8.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f),
            )

            Spacer(Modifier.height(12.dp))

            OutlinedTextField(
                value = state.url,
                onValueChange = viewModel::setUrl,
                label = { Text("Адрес сервера") },
                placeholder = { Text("http://192.168.1.5:8000") },
                singleLine = true,
                enabled = !state.testing,
                isError = state.error != null,
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(12.dp),
            )

            if (state.error != null) {
                Spacer(Modifier.height(8.dp))
                Text(
                    state.error.orEmpty(),
                    color = MaterialTheme.colorScheme.error,
                    fontSize = 13.sp,
                )
            }

            Spacer(Modifier.height(16.dp))

            OutlinedButton(
                onClick = viewModel::testAndSave,
                enabled = !state.testing && state.url.isNotBlank(),
                modifier = Modifier.fillMaxWidth().height(48.dp),
            ) {
                if (state.testing) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(18.dp),
                        strokeWidth = 2.dp,
                    )
                    Spacer(Modifier.size(8.dp))
                    Text("Проверяем…")
                } else {
                    Text("Проверить и сохранить", fontWeight = FontWeight.Medium)
                }
            }
        }
    }
}

@Composable
private fun ScannerUI(
    onCancel: () -> Unit,
    onCode: (String) -> Unit,
) {
    Box(modifier = Modifier.fillMaxSize().background(Color.Black)) {
        QrScannerView(
            modifier = Modifier.fillMaxSize(),
            onResult = onCode,
        )
        // Прицел в центре
        Box(
            modifier = Modifier
                .align(Alignment.Center)
                .size(240.dp)
                .border(2.dp, Color.White, RoundedCornerShape(16.dp))
                .clip(RoundedCornerShape(16.dp)),
        )
        Column(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .systemBarsPadding()
                .padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                "Наведите камеру на QR с экрана кассы",
                color = Color.White,
                fontSize = 14.sp,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(12.dp))
            TextButton(onClick = onCancel) {
                Text("Отмена", color = Color.White)
            }
        }
    }
}
