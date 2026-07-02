package com.restos.kds.ui.setup

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import com.restos.kds.ui.theme.KdsColors

@Composable
fun KdsSetupScreen(vm: KdsSetupViewModel = hiltViewModel(), onDone: () -> Unit) {
    val s by vm.state.collectAsStateWithLifecycle()
    Box(Modifier.fillMaxSize().background(KdsColors.Bg), Alignment.Center) {
        Column(
            Modifier.width(460.dp).clip(RoundedCornerShape(20.dp)).background(KdsColors.Card).padding(28.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text("RestOS Кухня", color = KdsColors.TextHi, fontSize = 26.sp, fontWeight = FontWeight.Bold)
            Text("Подключение к серверу кассы", color = KdsColors.TextMid, fontSize = 14.sp)

            val colors = TextFieldDefaults.colors(
                focusedContainerColor = KdsColors.ColBg,
                unfocusedContainerColor = KdsColors.ColBg,
                focusedTextColor = KdsColors.TextHi,
                unfocusedTextColor = KdsColors.TextHi,
                cursorColor = KdsColors.New,
            )
            OutlinedTextField(
                value = s.url, onValueChange = vm::setUrl,
                label = { Text("Адрес сервера", color = KdsColors.TextMid) },
                singleLine = true, colors = colors, modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = s.pin, onValueChange = vm::setPin,
                label = { Text("PIN повара", color = KdsColors.TextMid) },
                singleLine = true, colors = colors,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                modifier = Modifier.fillMaxWidth(),
            )
            if (s.error != null) {
                Text(s.error!!, color = KdsColors.Urgent, fontSize = 14.sp)
            }
            Box(
                Modifier.fillMaxWidth().height(56.dp).clip(RoundedCornerShape(14.dp))
                    .background(if (s.busy) KdsColors.TextDim else KdsColors.New)
                    .clickable(enabled = !s.busy) { vm.submit(onDone) },
                contentAlignment = Alignment.Center,
            ) {
                if (s.busy) CircularProgressIndicator(color = KdsColors.OnSolid, strokeWidth = 2.dp, modifier = Modifier.height(22.dp).width(22.dp))
                else Text("Войти", color = KdsColors.OnSolid, fontSize = 18.sp, fontWeight = FontWeight.Bold)
            }
        }
    }
}
