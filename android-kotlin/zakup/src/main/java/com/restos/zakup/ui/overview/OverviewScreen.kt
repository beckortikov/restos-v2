package com.restos.zakup.ui.overview

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import com.restos.zakup.ui.shell.ZakupPlaceholder
import com.restos.zakup.ui.shell.ZakupScreenHeader
import com.restos.zakup.ui.theme.ZakupColors

/** Экран 02 «Обзор закупок» — метрики + «Что закупить» + последние приёмки.
 *  В Ф0 — каркас; наполнение данными в Ф1. */
@Composable
fun OverviewScreen(restaurantName: String?) {
    Column(Modifier.fillMaxSize()) {
        ZakupScreenHeader(
            title = "Обзор закупок",
            subtitle = restaurantName ?: "RestOS",
        )
        ZakupPlaceholder("Метрики и список закупок — Ф1")
    }
}
