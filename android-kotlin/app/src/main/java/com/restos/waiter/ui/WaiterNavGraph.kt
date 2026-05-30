package com.restos.waiter.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.restos.waiter.ui.auth.AuthGateViewModel
import com.restos.waiter.ui.auth.AuthStatus
import com.restos.waiter.ui.composer.NewOrderScreen
import com.restos.waiter.ui.lan.LanGuard
import com.restos.waiter.ui.login.PinLoginScreen
import com.restos.waiter.ui.onboarding.OnboardingScreen
import com.restos.waiter.ui.order.OrderDetailScreen
import com.restos.waiter.ui.orders.ActiveOrdersScreen
import com.restos.waiter.ui.shell.WaiterShell
import com.restos.waiter.ui.shell.WaiterTab
import com.restos.waiter.ui.tables.SelectTableForNewOrderScreen
import com.restos.waiter.ui.tables.TablesScreen

object Routes {
    const val ONBOARDING = "onboarding"
    const val LOGIN = "login"
    const val APP = "app"
    const val SELECT_TABLE = "tables/select"
    const val ORDER_NEW = "order/new?tableId={tableId}&orderId={orderId}"
    const val ORDER_DETAIL = "order/{orderId}"

    /**
     * v4: ID — UUID-строки. Используем пустую строку как sentinel (""=null),
     * чтобы Nav-аргументы оставались non-null.
     */
    fun orderNew(tableId: String? = null, orderId: String? = null): String {
        val tid = tableId?.takeIf { it.isNotBlank() } ?: ""
        val oid = orderId?.takeIf { it.isNotBlank() } ?: ""
        return "order/new?tableId=$tid&orderId=$oid"
    }
    fun orderDetail(orderId: String): String = "order/$orderId"
}

@Composable
fun WaiterNavGraph(
    gateViewModel: AuthGateViewModel = hiltViewModel(),
) {
    val status by gateViewModel.status.collectAsStateWithLifecycle()

    if (status == AuthStatus.Unknown) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }
        return
    }

    val navController = rememberNavController()
    val startDestination = when (status) {
        AuthStatus.NeedsOnboarding -> Routes.ONBOARDING
        AuthStatus.LoggedIn -> Routes.APP
        else -> Routes.LOGIN
    }

    NavHost(navController = navController, startDestination = startDestination) {
        composable(Routes.ONBOARDING) {
            OnboardingScreen(
                onDone = {
                    navController.navigate(Routes.LOGIN) {
                        popUpTo(Routes.ONBOARDING) { inclusive = true }
                    }
                },
            )
        }
        composable(Routes.LOGIN) {
            PinLoginScreen(
                onLoggedIn = {
                    navController.navigate(Routes.APP) {
                        popUpTo(Routes.LOGIN) { inclusive = true }
                    }
                },
            )
        }
        composable(Routes.APP) {
            LanGuard {
                AppShellHost(
                    onOpenOrder = { id -> navController.navigate(Routes.orderDetail(id)) },
                    onResumeDraft = { tableId -> navController.navigate(Routes.orderNew(tableId)) },
                    onSelectTableForNew = { navController.navigate(Routes.SELECT_TABLE) },
                    onLoggedOut = {
                        navController.navigate(Routes.LOGIN) {
                            popUpTo(Routes.APP) { inclusive = true }
                        }
                    },
                )
            }
        }
        composable(Routes.SELECT_TABLE) {
            LanGuard {
                SelectTableForNewOrderScreen(
                    onBack = { navController.popBackStack() },
                    onPick = { tableId ->
                        navController.navigate(Routes.orderNew(tableId)) {
                            popUpTo(Routes.APP)
                        }
                    },
                )
            }
        }
        composable(
            route = Routes.ORDER_NEW,
            arguments = listOf(
                navArgument("tableId") {
                    type = NavType.StringType
                    nullable = false
                    defaultValue = ""
                },
                navArgument("orderId") {
                    type = NavType.StringType
                    nullable = false
                    defaultValue = ""
                },
            ),
        ) {
            LanGuard {
                NewOrderScreen(
                    onBack = { navController.popBackStack() },
                    onOrderCreated = { orderId ->
                        navController.navigate(Routes.orderDetail(orderId)) {
                            popUpTo(Routes.APP)
                        }
                    },
                )
            }
        }
        composable(
            route = Routes.ORDER_DETAIL,
            arguments = listOf(navArgument("orderId") { type = NavType.StringType }),
        ) {
            LanGuard {
                OrderDetailScreen(
                    onBack = { navController.popBackStack() },
                    onFinished = {
                        navController.navigate(Routes.APP) {
                            popUpTo(Routes.APP) { inclusive = true }
                        }
                    },
                    onAddItems = { orderId, tableId ->
                        navController.navigate(Routes.orderNew(tableId = tableId, orderId = orderId))
                    },
                    onNewGroup = { tableId ->
                        navController.navigate(Routes.orderNew(tableId = tableId)) {
                            popUpTo(Routes.APP)
                        }
                    },
                    onSwitchGroup = { otherOrderId ->
                        navController.navigate(Routes.orderDetail(otherOrderId)) {
                            popUpTo(Routes.ORDER_DETAIL) { inclusive = true }
                        }
                    },
                )
            }
        }
    }
}

@Composable
private fun AppShellHost(
    onOpenOrder: (String) -> Unit,
    onResumeDraft: (String) -> Unit,
    onSelectTableForNew: () -> Unit,
    onLoggedOut: () -> Unit,
) {
    var currentTab by remember { mutableIntStateOf(WaiterTab.Tables.ordinal) }
    var refreshTick by remember { mutableIntStateOf(0) }

    WaiterShell(
        currentTab = WaiterTab.entries[currentTab],
        onSelectTab = { currentTab = it.ordinal },
        onRefresh = { refreshTick++ },
        onLoggedOut = onLoggedOut,
    ) {
        when (WaiterTab.entries[currentTab]) {
            WaiterTab.Tables -> TablesScreen(
                onOpenOrder = onOpenOrder,
                onResumeDraft = onResumeDraft,
                onSelectTableForNew = onSelectTableForNew,
            )
            WaiterTab.Orders -> ActiveOrdersScreen(onOpenOrder = onOpenOrder)
        }
    }
}
