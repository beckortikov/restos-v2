package com.restos.zakup.ui.suppliers

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
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
import androidx.compose.runtime.mutableStateListOf
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
import com.restos.zakup.data.suppliers.SupplierInput
import com.restos.zakup.ui.theme.ZakupColors
import com.restos.zakup.ui.theme.ZakupRadius

/**
 * Форма нового поставщика — bottom-sheet. name обязателен; категории добавляются
 * из подсказок (уже используемые) в один тап либо вводом свободного текста.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun NewSupplierSheet(
    saving: Boolean,
    error: String?,
    knownCategories: List<String>,
    onDismiss: () -> Unit,
    onSave: (SupplierInput) -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var name by remember { mutableStateOf("") }
    var contact by remember { mutableStateOf("") }
    var phone by remember { mutableStateOf("") }
    var terms by remember { mutableStateOf("") }
    var creditLimit by remember { mutableStateOf("") }
    var categoryInput by remember { mutableStateOf("") }
    val categories = remember { mutableStateListOf<String>() }

    fun addCategory(raw: String) {
        val c = raw.trim()
        if (c.isNotEmpty() && categories.none { it.equals(c, ignoreCase = true) }) categories.add(c)
    }

    val canSave = name.isNotBlank() && !saving

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = ZakupColors.Surface,
        shape = RoundedCornerShape(topStart = ZakupRadius.sheet, topEnd = ZakupRadius.sheet),
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp)
                .padding(bottom = 12.dp)
                .navigationBarsPadding(),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Новый поставщик", fontSize = 18.sp, fontWeight = FontWeight.Bold, color = ZakupColors.TextPrimary, modifier = Modifier.weight(1f))
                Surface(onClick = onDismiss, shape = CircleShape, color = ZakupColors.SurfaceMuted, modifier = Modifier.size(34.dp)) {
                    Box(contentAlignment = Alignment.Center) {
                        Icon(Icons.Outlined.Close, contentDescription = "Закрыть", tint = ZakupColors.TextSecondary, modifier = Modifier.size(18.dp))
                    }
                }
            }
            Spacer(Modifier.height(16.dp))

            FieldLabel("Название")
            FormField(name, { name = it }, placeholder = "Напр. Ферма «Восход»", accent = true)

            Spacer(Modifier.height(14.dp))
            FieldLabel("Контактное лицо")
            FormField(contact, { contact = it }, placeholder = "Напр. Азиз Каримов")

            Spacer(Modifier.height(14.dp))
            FieldLabel("Телефон")
            FormField(phone, { phone = it }, placeholder = "+998 90 123 45 67", keyboardType = KeyboardType.Phone)

            Spacer(Modifier.height(14.dp))
            FieldLabel("Категории")
            // Выбранные категории — чипы с крестиком.
            if (categories.isNotEmpty()) {
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                    modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp),
                ) {
                    categories.forEach { cat ->
                        Surface(shape = RoundedCornerShape(ZakupRadius.badge), color = ZakupColors.PrimarySoft) {
                            Row(Modifier.padding(start = 10.dp, end = 6.dp, top = 5.dp, bottom = 5.dp), verticalAlignment = Alignment.CenterVertically) {
                                Text(cat, fontSize = 12.5.sp, color = ZakupColors.Primary, fontWeight = FontWeight.SemiBold)
                                Spacer(Modifier.size(4.dp))
                                Icon(
                                    Icons.Outlined.Close,
                                    contentDescription = "Убрать",
                                    tint = ZakupColors.Primary,
                                    modifier = Modifier.size(14.dp).clickable { categories.remove(cat) },
                                )
                            }
                        }
                    }
                }
            }
            // Поле ввода своей категории + кнопка «+».
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.weight(1f)) {
                    FormField(categoryInput, { categoryInput = it }, placeholder = "Добавить категорию")
                }
                Spacer(Modifier.size(8.dp))
                Surface(
                    onClick = { addCategory(categoryInput); categoryInput = "" },
                    enabled = categoryInput.isNotBlank(),
                    shape = RoundedCornerShape(ZakupRadius.tile),
                    color = if (categoryInput.isNotBlank()) ZakupColors.PrimarySoft else ZakupColors.SurfaceMuted,
                    modifier = Modifier.size(48.dp),
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        Icon(Icons.Outlined.Add, contentDescription = "Добавить", tint = if (categoryInput.isNotBlank()) ZakupColors.Primary else ZakupColors.TextTertiary, modifier = Modifier.size(20.dp))
                    }
                }
            }
            // Подсказки-чипы: предопределённые группы (как в основной программе) +
            // ранее использованные категории. Уже выбранные не показываем.
            fun notSelected(list: List<String>) = list.filter { s -> categories.none { it.equals(s, ignoreCase = true) } }
            SUPPLIER_CATEGORY_GROUPS.forEach { group ->
                val chips = notSelected(group.items)
                if (chips.isNotEmpty()) {
                    Spacer(Modifier.height(10.dp))
                    Text(group.label, fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold, color = ZakupColors.TextTertiary, modifier = Modifier.padding(bottom = 6.dp))
                    SuggestionChips(chips, onPick = { addCategory(it) })
                }
            }
            // Ранее использованные — то, чего нет в предопределённых группах.
            val presetAll = SUPPLIER_CATEGORY_GROUPS.flatMap { it.items }
            val known = notSelected(knownCategories).filter { k -> presetAll.none { it.equals(k, ignoreCase = true) } }
            if (known.isNotEmpty()) {
                Spacer(Modifier.height(10.dp))
                Text("Ранее использованные", fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold, color = ZakupColors.TextTertiary, modifier = Modifier.padding(bottom = 6.dp))
                SuggestionChips(known, onPick = { addCategory(it) })
            }

            Spacer(Modifier.height(14.dp))
            Row {
                Column(Modifier.weight(1f)) {
                    FieldLabel("Отсрочка, дней")
                    FormField(terms, { terms = it.filter(Char::isDigit) }, placeholder = "0", keyboardType = KeyboardType.Number)
                }
                Spacer(Modifier.size(12.dp))
                Column(Modifier.weight(1f)) {
                    FieldLabel("Лимит долга")
                    FormField(creditLimit, { creditLimit = it.filter { c -> c.isDigit() || c == '.' } }, placeholder = "0", keyboardType = KeyboardType.Number, suffix = "сум")
                }
            }

            if (error != null) {
                Spacer(Modifier.height(10.dp))
                Text(error, color = ZakupColors.Danger, fontSize = 13.sp)
            }

            Spacer(Modifier.height(18.dp))
            Surface(
                onClick = {
                    onSave(
                        SupplierInput(
                            name = name.trim(),
                            contactPerson = contact.trim().takeIf { it.isNotEmpty() },
                            phone = phone.trim().takeIf { it.isNotEmpty() },
                            categories = categories.toList().takeIf { it.isNotEmpty() },
                            paymentTermsDays = terms.toIntOrNull(),
                            creditLimit = creditLimit.trim().takeIf { it.isNotEmpty() },
                        ),
                    )
                },
                enabled = canSave,
                shape = RoundedCornerShape(ZakupRadius.button),
                color = if (canSave) ZakupColors.Primary else ZakupColors.Primary.copy(alpha = 0.4f),
                modifier = Modifier.fillMaxWidth().height(52.dp),
            ) {
                Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                    if (saving) {
                        CircularProgressIndicator(color = ZakupColors.OnPrimary, strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
                    } else {
                        Text("Сохранить поставщика", color = ZakupColors.OnPrimary, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                    }
                }
            }
        }
    }
}

@Composable
private fun FieldLabel(text: String) {
    Text(text, fontSize = 13.sp, color = ZakupColors.TextSecondary, modifier = Modifier.padding(bottom = 6.dp))
}

@Composable
private fun FormField(
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

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SuggestionChips(items: List<String>, onPick: (String) -> Unit) {
    FlowRow(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        items.forEach { s ->
            Surface(
                onClick = { onPick(s) },
                shape = RoundedCornerShape(ZakupRadius.badge),
                color = ZakupColors.Surface,
                border = BorderStroke(1.dp, ZakupColors.Border),
            ) {
                Text("+ $s", fontSize = 12.5.sp, color = ZakupColors.TextSecondary, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp))
            }
        }
    }
}

private data class CategoryGroup(val label: String, val items: List<String>)

/** Предопределённые категории поставщика — зеркало web-формы suppliers/new. */
private val SUPPLIER_CATEGORY_GROUPS = listOf(
    CategoryGroup(
        "Продукты питания",
        listOf(
            "Мясо", "Птица", "Рыба", "Морепродукты",
            "Овощи", "Фрукты", "Зелень", "Грибы",
            "Крупы", "Бобовые", "Макароны",
            "Мука", "Хлеб", "Выпечка",
            "Молочные", "Сыры", "Яйца",
            "Масла", "Специи", "Соусы",
            "Напитки", "Чай", "Кофе", "Соки",
            "Заморозка", "Консервы",
            "Сухофрукты", "Орехи",
            "Кондитерские", "Сахар", "Мёд",
            "Прочие продукты",
        ),
    ),
    CategoryGroup(
        "Хозяйственные товары",
        listOf(
            "Салфетки", "Бумажные полотенца", "Туалетная бумага",
            "Зубочистки", "Трубочки",
            "Одноразовая посуда", "Одноразовые стаканы",
            "Моющие средства", "Дезинфекция",
            "Губки", "Тряпки",
            "Перчатки", "Фартуки",
            "Мусорные мешки",
            "Упаковка", "Пакеты", "Контейнеры",
            "Инвентарь",
            "Прочие хозтовары",
        ),
    ),
)
