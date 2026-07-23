package com.restos.zakup.ui.stock

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import com.restos.zakup.ui.shell.ZakupPlaceholder
import com.restos.zakup.ui.shell.ZakupScreenHeader

/** Экран 03 «Склад» — остатки с категориями и мин-порогами. Наполнение — Ф1. */
@Composable
fun StockScreen() {
    Column(Modifier.fillMaxSize()) {
        ZakupScreenHeader(title = "Склад")
        ZakupPlaceholder("Остатки ингредиентов — Ф1")
    }
}
