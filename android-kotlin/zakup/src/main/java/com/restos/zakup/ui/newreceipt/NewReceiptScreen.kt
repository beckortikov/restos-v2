package com.restos.zakup.ui.newreceipt

import androidx.compose.foundation.BorderStroke
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.restos.zakup.data.suppliers.SupplierDto
import com.restos.zakup.ui.components.Avatar
import com.restos.zakup.ui.components.ErrorState
import com.restos.zakup.ui.components.LoadingState
import com.restos.zakup.ui.components.ZakupCard
import com.restos.zakup.ui.components.ZakupTopBar
import com.restos.zakup.ui.theme.ZakupColors
import com.restos.zakup.ui.theme.ZakupRadius
import com.restos.zakup.util.formatMoney
import com.restos.zakup.util.initialsOf
import com.restos.zakup.util.toDecimalOrZero

/** Экран 05 «Новая приёмка». */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewReceiptScreen(
    onBack: () -> Unit,
    onCreated: () -> Unit,
    viewModel: NewReceiptViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    var showSearch by remember { mutableStateOf(false) }
    var showPicker by remember { mutableStateOf(false) }

    LaunchedEffect(state.done) { if (state.done) onCreated() }

    if (showSearch) {
        ItemSearchScreen(viewModel = viewModel, onClose = { showSearch = false })
        return
    }

    if (showPicker) {
        SupplierPicker(
            suppliers = state.suppliers,
            onPick = { viewModel.selectSupplier(it); showPicker = false },
            onDismiss = { showPicker = false },
        )
    }

    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        ZakupTopBar("Новая приёмка", onBack = onBack)

        when {
            state.loading -> LoadingState()
            state.loadError != null -> ErrorState(state.loadError!!, onRetry = viewModel::load)
            else -> Box(Modifier.weight(1f)) {
                LazyColumn(
                    contentPadding = PaddingValues(horizontal = 20.dp, vertical = 4.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    item { Label("Поставщик") }
                    item { SupplierRow(state, onClick = { showPicker = true }) }

                    item { Label("Позиции · ${state.lines.size}") }
                    items(state.lines, key = { it.ingredientId }) { line ->
                        LineCard(
                            line = line,
                            onQty = { viewModel.setQty(line.ingredientId, it) },
                            onPrice = { viewModel.setPrice(line.ingredientId, it) },
                            onRemove = { viewModel.removeLine(line.ingredientId) },
                        )
                    }
                    item { AddPositionButton(onClick = { showSearch = true }) }

                    item { Label("Оплата") }
                    item { PaymentToggle(state.payment, viewModel::setPayment) }
                    if (state.payment == PaymentType.Paid) {
                        item { AccountRow(state, viewModel::selectAccount) }
                    }

                    if (state.submitError != null) {
                        item { Text(state.submitError!!, color = ZakupColors.Danger, fontSize = 13.sp) }
                    }
                    item { Spacer(Modifier.height(96.dp)) }
                }

                SubmitBar(
                    total = state.total,
                    enabled = state.canSubmit,
                    submitting = state.submitting,
                    onSubmit = viewModel::submit,
                    modifier = Modifier.align(Alignment.BottomCenter),
                )
            }
        }
    }
}

@Composable
private fun Label(text: String) {
    Text(text, fontSize = 13.sp, fontWeight = FontWeight.Bold, color = ZakupColors.TextTertiary, modifier = Modifier.padding(start = 4.dp, top = 4.dp))
}

@Composable
private fun SupplierRow(state: NewReceiptUiState, onClick: () -> Unit) {
    ZakupCard(Modifier.fillMaxWidth().clickable(onClick = onClick), padding = 14) {
        if (state.supplierId == null) {
            Text("Выберите поставщика", fontSize = 14.5.sp, color = ZakupColors.TextTertiary)
        } else {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Avatar(initialsOf(state.supplierName ?: "—"))
                Spacer(Modifier.size(12.dp))
                Column {
                    Text(state.supplierName ?: "—", style = MaterialTheme.typography.titleMedium)
                    val cats = state.supplierCategories.joinToString(", ")
                    val debt = if (state.supplierDebt.signum() > 0) "долг ${formatMoney(state.supplierDebt, "")}" else null
                    val sub = listOfNotNull(cats.takeIf { it.isNotBlank() }, debt).joinToString(" · ")
                    if (sub.isNotBlank()) {
                        Spacer(Modifier.size(2.dp))
                        Text(sub, fontSize = 12.5.sp, color = ZakupColors.TextTertiary)
                    }
                }
            }
        }
    }
}

@Composable
private fun LineCard(line: DraftLine, onQty: (String) -> Unit, onPrice: (String) -> Unit, onRemove: () -> Unit) {
    ZakupCard(Modifier.fillMaxWidth(), padding = 14) {
        Column {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(line.name, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                Text(formatMoney(line.lineTotal, ""), fontSize = 14.5.sp, fontWeight = FontWeight.Bold, color = ZakupColors.TextPrimary)
                Spacer(Modifier.size(8.dp))
                Surface(onClick = onRemove, shape = RoundedCornerShape(ZakupRadius.badge), color = ZakupColors.SurfaceMuted, modifier = Modifier.size(28.dp)) {
                    Box(contentAlignment = Alignment.Center) {
                        Icon(Icons.Outlined.Close, contentDescription = "Убрать", tint = ZakupColors.TextTertiary, modifier = Modifier.size(16.dp))
                    }
                }
            }
            Spacer(Modifier.size(10.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                NumField(line.qty, onQty, placeholder = "кол-во", suffix = line.unit, modifier = Modifier.weight(1f))
                Text("×", fontSize = 15.sp, color = ZakupColors.TextTertiary, modifier = Modifier.padding(horizontal = 10.dp))
                NumField(line.price, onPrice, placeholder = "цена", suffix = "сум", modifier = Modifier.weight(1.3f))
            }
        }
    }
}

@Composable
private fun NumField(value: String, onChange: (String) -> Unit, placeholder: String, suffix: String?, modifier: Modifier) {
    Surface(shape = RoundedCornerShape(ZakupRadius.small), color = ZakupColors.SurfaceMuted, modifier = modifier) {
        Row(Modifier.padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            TextField(
                value = value,
                onValueChange = onChange,
                placeholder = { Text(placeholder, color = ZakupColors.TextTertiary, fontSize = 14.sp) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
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
            if (suffix != null) Text(suffix, fontSize = 12.sp, color = ZakupColors.TextTertiary, modifier = Modifier.padding(end = 10.dp))
        }
    }
}

@Composable
private fun AddPositionButton(onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(ZakupRadius.button),
        color = ZakupColors.Surface,
        border = BorderStroke(1.dp, ZakupColors.Border),
        modifier = Modifier.fillMaxWidth().height(50.dp),
    ) {
        Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.Add, contentDescription = null, tint = ZakupColors.Primary)
            Spacer(Modifier.size(8.dp))
            Text("Добавить позицию", color = ZakupColors.Primary, fontSize = 14.5.sp, fontWeight = FontWeight.SemiBold)
        }
    }
}

@Composable
private fun PaymentToggle(payment: PaymentType, onSelect: (PaymentType) -> Unit) {
    Surface(shape = RoundedCornerShape(ZakupRadius.tile), color = ZakupColors.SurfaceMuted, modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.padding(4.dp)) {
            SegItem("Оплачено", payment == PaymentType.Paid, Modifier.weight(1f)) { onSelect(PaymentType.Paid) }
            SegItem("В долг", payment == PaymentType.Credit, Modifier.weight(1f)) { onSelect(PaymentType.Credit) }
        }
    }
}

@Composable
private fun SegItem(label: String, active: Boolean, modifier: Modifier, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(ZakupRadius.small),
        color = if (active) ZakupColors.Surface else Color.Transparent,
        modifier = modifier.height(40.dp),
    ) {
        Box(contentAlignment = Alignment.Center) {
            Text(label, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, color = if (active) ZakupColors.TextPrimary else ZakupColors.TextSecondary)
        }
    }
}

@Composable
private fun AccountRow(state: NewReceiptUiState, onSelect: (String) -> Unit) {
    Column {
        state.accounts.forEach { acc ->
            val selected = acc.id == state.accountId
            Surface(
                shape = RoundedCornerShape(ZakupRadius.tile),
                color = if (selected) ZakupColors.PrimarySoft else ZakupColors.Surface,
                border = BorderStroke(1.dp, if (selected) ZakupColors.Primary else ZakupColors.Border),
                modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp).clickable { onSelect(acc.id) },
            ) {
                Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(acc.name.ifBlank { acc.type }, fontSize = 14.5.sp, fontWeight = FontWeight.SemiBold, color = ZakupColors.TextPrimary, modifier = Modifier.weight(1f))
                    Text("Остаток ${formatMoney(acc.balance.toDecimalOrZero())}", fontSize = 12.sp, color = ZakupColors.TextTertiary)
                }
            }
        }
    }
}

@Composable
private fun SubmitBar(total: java.math.BigDecimal, enabled: Boolean, submitting: Boolean, onSubmit: () -> Unit, modifier: Modifier) {
    Surface(color = ZakupColors.Bg, modifier = modifier.fillMaxWidth()) {
        Column(Modifier.padding(20.dp).navigationBarsPadding()) {
            Row(Modifier.fillMaxWidth().padding(bottom = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Итого", fontSize = 14.sp, color = ZakupColors.TextSecondary, modifier = Modifier.weight(1f))
                Text(formatMoney(total), fontSize = 18.sp, fontWeight = FontWeight.Bold, color = ZakupColors.TextPrimary)
            }
            Surface(
                onClick = onSubmit,
                enabled = enabled,
                shape = RoundedCornerShape(ZakupRadius.button),
                color = if (enabled) ZakupColors.Primary else ZakupColors.Primary.copy(alpha = 0.4f),
                modifier = Modifier.fillMaxWidth().height(54.dp),
            ) {
                Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                    if (submitting) CircularProgressIndicator(color = ZakupColors.OnPrimary, strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
                    else Text("Провести приёмку", color = ZakupColors.OnPrimary, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SupplierPicker(suppliers: List<SupplierDto>, onPick: (SupplierDto) -> Unit, onDismiss: () -> Unit) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = ZakupColors.Surface,
        shape = RoundedCornerShape(topStart = ZakupRadius.sheet, topEnd = ZakupRadius.sheet),
    ) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).navigationBarsPadding()) {
            Text("Поставщик", fontSize = 18.sp, fontWeight = FontWeight.Bold, color = ZakupColors.TextPrimary)
            Spacer(Modifier.height(12.dp))
            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(suppliers, key = { it.id }) { s ->
                    Surface(
                        onClick = { onPick(s) },
                        shape = RoundedCornerShape(ZakupRadius.tile),
                        color = ZakupColors.Surface,
                        border = BorderStroke(1.dp, ZakupColors.Border),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                            Avatar(initialsOf(s.name), size = 40)
                            Spacer(Modifier.size(12.dp))
                            Text(s.name.ifBlank { "—" }, fontSize = 14.5.sp, fontWeight = FontWeight.SemiBold, color = ZakupColors.TextPrimary, modifier = Modifier.weight(1f))
                            if (s.currentDebt.toDecimalOrZero().signum() > 0) {
                                Text("долг", fontSize = 11.sp, color = ZakupColors.Danger, fontWeight = FontWeight.Bold)
                            }
                        }
                    }
                }
                item { Spacer(Modifier.height(8.dp)) }
            }
        }
    }
}
