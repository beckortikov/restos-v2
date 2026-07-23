package com.restos.zakup.ui.suppliers

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import com.restos.zakup.ui.shell.ZakupPlaceholder
import com.restos.zakup.ui.shell.ZakupScreenHeader

/** Экран 04 «Поставщики» — общий долг + карточки поставщиков. Наполнение — Ф1. */
@Composable
fun SuppliersScreen() {
    Column(Modifier.fillMaxSize()) {
        ZakupScreenHeader(title = "Поставщики")
        ZakupPlaceholder("Долги и поставщики — Ф1")
    }
}
