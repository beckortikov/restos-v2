package com.restos.zakup.ui.newreceipt

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.restos.zakup.ui.theme.ZakupColors
import com.restos.zakup.ui.theme.ZakupRadius

private val UNIT_PRESETS = listOf("кг", "г", "л", "мл", "шт", "уп", "бут", "банка")

/**
 * Форма нового товара — bottom-sheet из поиска позиций приёмки. Тип (продукт/
 * хозтовар) → is_food, по нему бэк сам кладёт товар на нужный склад. После
 * создания товар сразу добавляется в приёмку.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewItemSheet(
    initialName: String,
    creating: Boolean,
    error: String?,
    onDismiss: () -> Unit,
    onCreate: (name: String, unit: String?, isFood: Boolean, price: String?) -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var name by remember { mutableStateOf(initialName.trim()) }
    var unit by remember { mutableStateOf("") }
    var price by remember { mutableStateOf("") }
    var isFood by remember { mutableStateOf(true) }
    val canSave = name.isNotBlank() && !creating

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = ZakupColors.Surface,
        shape = RoundedCornerShape(topStart = ZakupRadius.sheet, topEnd = ZakupRadius.sheet),
    ) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 12.dp).navigationBarsPadding(),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Новый товар", fontSize = 18.sp, fontWeight = FontWeight.Bold, color = ZakupColors.TextPrimary, modifier = Modifier.weight(1f))
                Surface(onClick = onDismiss, shape = CircleShape, color = ZakupColors.SurfaceMuted, modifier = Modifier.size(34.dp)) {
                    Box(contentAlignment = Alignment.Center) {
                        Icon(Icons.Outlined.Close, contentDescription = "Закрыть", tint = ZakupColors.TextSecondary, modifier = Modifier.size(18.dp))
                    }
                }
            }
            Spacer(Modifier.height(16.dp))

            Label("Название")
            Field(name, { name = it }, "Напр. Салфетки", accent = true)

            Spacer(Modifier.height(14.dp))
            Label("Тип")
            Surface(shape = RoundedCornerShape(ZakupRadius.tile), color = ZakupColors.SurfaceMuted, modifier = Modifier.fillMaxWidth()) {
                Row(Modifier.padding(4.dp)) {
                    TypeSeg("Продукт", isFood, Modifier.weight(1f)) { isFood = true }
                    TypeSeg("Хозтовар", !isFood, Modifier.weight(1f)) { isFood = false }
                }
            }

            Spacer(Modifier.height(14.dp))
            Label("Единица")
            Field(unit, { unit = it }, "кг / шт / л …")
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                UNIT_PRESETS.take(5).forEach { u ->
                    val active = unit.trim().equals(u, ignoreCase = true)
                    Surface(
                        onClick = { unit = u },
                        shape = RoundedCornerShape(ZakupRadius.badge),
                        color = if (active) ZakupColors.PrimarySoft else ZakupColors.Surface,
                        border = BorderStroke(1.dp, if (active) ZakupColors.Primary else ZakupColors.Border),
                    ) {
                        Text(u, fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold, color = if (active) ZakupColors.Primary else ZakupColors.TextSecondary, modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp))
                    }
                }
            }

            Spacer(Modifier.height(14.dp))
            Label("Цена за единицу (необязательно)")
            Field(price, { price = it.filter { c -> c.isDigit() || c == '.' } }, "0", keyboardType = KeyboardType.Number, suffix = "с.")

            if (error != null) {
                Spacer(Modifier.height(10.dp))
                Text(error, color = ZakupColors.Danger, fontSize = 13.sp)
            }

            Spacer(Modifier.height(18.dp))
            Surface(
                onClick = { onCreate(name.trim(), unit.trim().ifEmpty { null }, isFood, price.trim().ifEmpty { null }) },
                enabled = canSave,
                shape = RoundedCornerShape(ZakupRadius.button),
                color = if (canSave) ZakupColors.Primary else ZakupColors.Primary.copy(alpha = 0.4f),
                modifier = Modifier.fillMaxWidth().height(52.dp),
            ) {
                Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                    if (creating) CircularProgressIndicator(color = ZakupColors.OnPrimary, strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
                    else Text("Создать и добавить", color = ZakupColors.OnPrimary, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                }
            }
        }
    }
}

@Composable
private fun Label(text: String) {
    Text(text, fontSize = 13.sp, color = ZakupColors.TextSecondary, modifier = Modifier.padding(bottom = 6.dp))
}

@Composable
private fun TypeSeg(label: String, active: Boolean, modifier: Modifier, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(9.dp),
        color = if (active) ZakupColors.Surface else Color.Transparent,
        modifier = modifier.height(40.dp),
    ) {
        Box(contentAlignment = Alignment.Center) {
            Text(label, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, color = if (active) ZakupColors.TextPrimary else ZakupColors.TextSecondary)
        }
    }
}

@Composable
private fun Field(
    value: String,
    onChange: (String) -> Unit,
    placeholder: String,
    accent: Boolean = false,
    keyboardType: KeyboardType = KeyboardType.Text,
    suffix: String? = null,
) {
    Surface(
        shape = RoundedCornerShape(ZakupRadius.tile),
        color = ZakupColors.Surface,
        border = BorderStroke(if (accent) 1.5.dp else 1.dp, if (accent) ZakupColors.Primary else ZakupColors.Border),
        modifier = Modifier.fillMaxWidth().heightIn(min = 50.dp),
    ) {
        Row(Modifier.padding(horizontal = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            TextField(
                value = value,
                onValueChange = onChange,
                placeholder = { Text(placeholder, color = ZakupColors.TextTertiary, fontSize = 14.sp) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
                modifier = Modifier.weight(1f),
                colors = TextFieldDefaults.colors(
                    focusedContainerColor = Color.Transparent,
                    unfocusedContainerColor = Color.Transparent,
                    focusedIndicatorColor = Color.Transparent,
                    unfocusedIndicatorColor = Color.Transparent,
                    focusedTextColor = ZakupColors.TextPrimary,
                    unfocusedTextColor = ZakupColors.TextPrimary,
                ),
            )
            if (suffix != null) Text(suffix, fontSize = 13.sp, color = ZakupColors.TextTertiary, modifier = Modifier.padding(end = 12.dp))
        }
    }
}
