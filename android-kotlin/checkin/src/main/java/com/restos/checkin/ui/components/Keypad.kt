package com.restos.checkin.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Backspace
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.restos.checkin.R
import com.restos.checkin.ui.theme.CheckinColors
import com.restos.checkin.ui.theme.CheckinRadius

/**
 * Цифровой блок и точки-индикаторы PIN — общие для активации терминала и для
 * отметки сотрудника. Экраны разные, но клавиатура одна: сотрудник видит её
 * каждый день по два раза, и расхождение между ними читалось бы как «что-то
 * сломалось».
 */
@Composable
fun PinDots(
    length: Int,
    max: Int,
    modifier: Modifier = Modifier,
    dotSize: Dp = 16.dp,
) {
    Row(modifier = modifier, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        repeat(max) { i ->
            val filled = i < length
            Surface(
                shape = CircleShape,
                color = if (filled) CheckinColors.Primary else Color.Transparent,
                border = if (filled) null else BorderStroke(2.dp, CheckinColors.TextTertiary),
                modifier = Modifier.size(dotSize),
                content = {},
            )
        }
    }
}

@Composable
fun Keypad(
    onDigit: (Char) -> Unit,
    onClear: () -> Unit,
    onBackspace: () -> Unit,
    enabled: Boolean,
    modifier: Modifier = Modifier,
    keyHeight: Dp = 66.dp,
    digitSize: TextUnit = 24.sp,
) {
    val rows = listOf(
        listOf('1', '2', '3'),
        listOf('4', '5', '6'),
        listOf('7', '8', '9'),
    )
    Column(
        verticalArrangement = Arrangement.spacedBy(10.dp),
        modifier = modifier.fillMaxWidth(),
    ) {
        rows.forEach { row ->
            Row(
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                row.forEach { c ->
                    KeyCell(Modifier.weight(1f), keyHeight, enabled, onClick = { onDigit(c) }) {
                        Text(
                            c.toString(),
                            fontSize = digitSize,
                            fontWeight = FontWeight.SemiBold,
                            color = CheckinColors.TextPrimary,
                        )
                    }
                }
            }
        }
        Row(
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            modifier = Modifier.fillMaxWidth(),
        ) {
            KeyCell(Modifier.weight(1f), keyHeight, enabled, onClick = onClear) {
                Text(
                    "Очистить",
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = CheckinColors.TextSecondary,
                )
            }
            KeyCell(Modifier.weight(1f), keyHeight, enabled, onClick = { onDigit('0') }) {
                Text(
                    "0",
                    fontSize = digitSize,
                    fontWeight = FontWeight.SemiBold,
                    color = CheckinColors.TextPrimary,
                )
            }
            KeyCell(Modifier.weight(1f), keyHeight, enabled, onClick = onBackspace) {
                Icon(
                    Icons.AutoMirrored.Outlined.Backspace,
                    contentDescription = stringResource(R.string.pin_backspace),
                    tint = CheckinColors.TextSecondary,
                    modifier = Modifier.size(22.dp),
                )
            }
        }
    }
}

@Composable
private fun KeyCell(
    modifier: Modifier,
    height: Dp,
    enabled: Boolean,
    onClick: () -> Unit,
    content: @Composable () -> Unit,
) {
    Surface(
        modifier = modifier.height(height),
        shape = RoundedCornerShape(CheckinRadius.tile),
        color = CheckinColors.SurfaceMuted,
        onClick = onClick,
        enabled = enabled,
    ) {
        Box(contentAlignment = Alignment.Center) { content() }
    }
}
