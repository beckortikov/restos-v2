package com.restos.zakup.ui.shell

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.GridView
import androidx.compose.material.icons.outlined.Inventory2
import androidx.compose.material.icons.outlined.LocalShipping
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material3.Icon
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.restos.zakup.ui.more.MoreScreen
import com.restos.zakup.ui.overview.OverviewScreen
import com.restos.zakup.ui.stock.StockScreen
import com.restos.zakup.ui.suppliers.SuppliersScreen
import com.restos.zakup.ui.theme.ZakupColors
import com.restos.zakup.ui.theme.ZakupRadius

enum class ZakupTab(val title: String, val icon: ImageVector) {
    Overview("Обзор", Icons.Outlined.GridView),
    Stock("Склад", Icons.Outlined.Inventory2),
    Suppliers("Поставщики", Icons.Outlined.LocalShipping),
    More("Ещё", Icons.Outlined.Menu),
}

@Composable
fun ZakupShell(
    onLoggedOut: () -> Unit,
    onOpenSupplier: (String) -> Unit = {},
    onOpenHistory: () -> Unit = {},
    onOpenToBuy: () -> Unit = {},
    onNewReceipt: (String?) -> Unit = {},
    onOperation: (String) -> Unit = {},
    onResetServer: () -> Unit = {},
    viewModel: ZakupShellViewModel = hiltViewModel(),
) {
    val me by viewModel.me.collectAsStateWithLifecycle()
    var currentTab by remember { mutableIntStateOf(ZakupTab.Overview.ordinal) }
    val tab = ZakupTab.entries[currentTab]

    Scaffold(
        containerColor = ZakupColors.Bg,
        bottomBar = {
            ZakupBottomBar(
                current = tab,
                onSelect = { currentTab = it.ordinal },
            )
        },
    ) { inner ->
        Box(Modifier.fillMaxSize().padding(inner).statusBarsPadding()) {
            when (tab) {
                ZakupTab.Overview -> OverviewScreen(
                    restaurantName = me?.restaurant?.name,
                    onNewReceipt = { onNewReceipt(null) },
                    onOpenToBuy = onOpenToBuy,
                    onOpenHistory = onOpenHistory,
                    onOpenSuppliers = { currentTab = ZakupTab.Suppliers.ordinal },
                    onOpenMovements = { onOperation(com.restos.zakup.ui.more.MoreOps.MOVEMENTS) },
                )
                ZakupTab.Stock -> StockScreen(onBuyIngredient = onNewReceipt)
                ZakupTab.Suppliers -> SuppliersScreen(onOpenSupplier = onOpenSupplier)
                ZakupTab.More -> MoreScreen(
                    me = me,
                    onLogout = { viewModel.logout(onLoggedOut) },
                    onOperation = onOperation,
                    onOpenSuppliers = { currentTab = ZakupTab.Suppliers.ordinal },
                    onResetServer = { viewModel.resetServer(onResetServer) },
                )
            }
        }
    }
}

/** Нижняя навигация — плавающая белая капсула (r29) с тенью, как в макете:
 *  иконка + подпись у КАЖДОГО таба, активный — эмеральд + soft-пилюля (r23). */
@Composable
private fun ZakupBottomBar(
    current: ZakupTab,
    onSelect: (ZakupTab) -> Unit,
) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .navigationBarsPadding()
            .padding(start = 16.dp, end = 16.dp, bottom = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        Surface(
            color = ZakupColors.Surface,
            border = BorderStroke(1.dp, ZakupColors.Border),
            shape = RoundedCornerShape(29.dp),
            modifier = Modifier
                .fillMaxWidth()
                .height(58.dp)
                .shadow(
                    elevation = 8.dp,
                    shape = RoundedCornerShape(29.dp),
                    ambientColor = ZakupColors.Shadow.copy(alpha = 0.06f),
                    spotColor = ZakupColors.Shadow.copy(alpha = 0.06f),
                ),
        ) {
            Row(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(6.dp),
                horizontalArrangement = Arrangement.spacedBy(2.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                ZakupTab.entries.forEach { t ->
                    val selected = t == current
                    Column(
                        modifier = Modifier
                            .weight(1f)
                            .fillMaxHeight()
                            .background(
                                color = if (selected) ZakupColors.PrimarySoft else Color.Transparent,
                                shape = RoundedCornerShape(23.dp),
                            )
                            .clickable { onSelect(t) },
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.Center,
                    ) {
                        Icon(
                            t.icon,
                            contentDescription = t.title,
                            tint = if (selected) ZakupColors.Primary else ZakupColors.TextTertiary,
                            modifier = Modifier.size(21.dp),
                        )
                        Spacer(Modifier.height(3.dp))
                        Text(
                            t.title,
                            color = if (selected) ZakupColors.Primary else ZakupColors.TextSecondary,
                            fontSize = 10.5.sp,
                            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
                        )
                    }
                }
            }
        }
    }
}

/** Общая шапка экрана таба (крупный заголовок на фоне страницы). */
@Composable
fun ZakupScreenHeader(title: String, subtitle: String? = null) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp)
            .padding(top = 8.dp, bottom = 12.dp),
    ) {
        Text(title, fontSize = 22.sp, fontWeight = FontWeight.Bold, color = ZakupColors.TextPrimary)
        if (subtitle != null) {
            Spacer(Modifier.height(2.dp))
            Text(subtitle, fontSize = 13.sp, color = ZakupColors.TextTertiary)
        }
    }
}

/** Заглушка-плейсхолдер контента таба (заменяется на реальные экраны в Ф1+). */
@Composable
fun ZakupPlaceholder(text: String) {
    Box(
        Modifier
            .fillMaxWidth()
            .padding(PaddingValues(top = 80.dp)),
        contentAlignment = Alignment.Center,
    ) {
        Text(text, color = ZakupColors.TextTertiary, fontSize = 14.sp)
    }
}
