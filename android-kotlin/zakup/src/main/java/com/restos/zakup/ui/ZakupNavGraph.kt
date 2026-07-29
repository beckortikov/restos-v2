package com.restos.zakup.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.restos.zakup.ui.auth.AuthGateViewModel
import com.restos.zakup.ui.auth.AuthStatus
import com.restos.zakup.ui.history.HistoryScreen
import com.restos.zakup.ui.login.PinLoginScreen
import com.restos.zakup.ui.more.MoreOps
import com.restos.zakup.ui.newreceipt.NewReceiptScreen
import com.restos.zakup.ui.onboarding.OnboardingScreen
import com.restos.zakup.ui.ops.InventoryScreen
import com.restos.zakup.ui.ops.MovementsScreen
import com.restos.zakup.ui.ops.OpeningBalanceScreen
import com.restos.zakup.ui.ops.ReturnScreen
import com.restos.zakup.ui.ops.ReturnsListScreen
import com.restos.zakup.ui.ops.SupplyExpenseScreen
import com.restos.zakup.ui.ops.WriteoffScreen
import com.restos.zakup.ui.shell.ZakupShell
import com.restos.zakup.ui.supplier.SupplierDetailScreen
import com.restos.zakup.ui.tobuy.ToBuyScreen

object Routes {
    const val ONBOARDING = "onboarding"
    const val LOGIN = "login"
    const val APP = "app"
    const val SUPPLIER_DETAIL = "supplier/{id}"
    const val HISTORY = "history"
    const val TO_BUY = "to-buy"
    const val NEW_RECEIPT = "receipt/new?ingredientId={ingredientId}"
    const val RETURN = "return/{receiptId}"

    fun supplier(id: String) = "supplier/$id"
    fun receiptReturn(receiptId: String) = "return/$receiptId"
    fun newReceipt(ingredientId: String? = null) = "receipt/new?ingredientId=${ingredientId.orEmpty()}"
}

@Composable
fun ZakupNavGraph(
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
                onResetServer = {
                    navController.navigate(Routes.ONBOARDING) {
                        popUpTo(Routes.LOGIN) { inclusive = true }
                    }
                },
            )
        }
        composable(Routes.APP) {
            ZakupShell(
                onLoggedOut = {
                    navController.navigate(Routes.LOGIN) {
                        popUpTo(Routes.APP) { inclusive = true }
                    }
                },
                onOpenSupplier = { id -> navController.navigate(Routes.supplier(id)) },
                onOpenHistory = { navController.navigate(Routes.HISTORY) },
                onOpenToBuy = { navController.navigate(Routes.TO_BUY) },
                onNewReceipt = { ingredientId -> navController.navigate(Routes.newReceipt(ingredientId)) },
                onOperation = { op -> navController.navigate("op/$op") },
                onResetServer = {
                    navController.navigate(Routes.ONBOARDING) {
                        popUpTo(Routes.APP) { inclusive = true }
                    }
                },
            )
        }
        composable(
            route = "op/{op}",
            arguments = listOf(navArgument("op") { type = NavType.StringType }),
        ) { entry ->
            val back = { navController.popBackStack(); Unit }
            val done = {
                navController.popBackStack()
                Unit
            }
            when (entry.arguments?.getString("op")) {
                MoreOps.WRITEOFF -> WriteoffScreen(onBack = back, onDone = done)
                MoreOps.INVENTORY -> InventoryScreen(onBack = back, onDone = done)
                MoreOps.SUPPLY_EXPENSE -> SupplyExpenseScreen(onBack = back, onDone = done)
                MoreOps.OPENING_BALANCE -> OpeningBalanceScreen(onBack = back, onDone = done)
                MoreOps.MOVEMENTS -> MovementsScreen(onBack = back)
                MoreOps.RETURNS -> ReturnsListScreen(onBack = back)
                MoreOps.WAREHOUSES -> com.restos.zakup.ui.reference.WarehousesScreen(onBack = back)
                MoreOps.CATEGORIES -> com.restos.zakup.ui.reference.CategoriesScreen(onBack = back)
            }
        }
        composable(
            route = Routes.NEW_RECEIPT,
            arguments = listOf(navArgument("ingredientId") { type = NavType.StringType; nullable = true; defaultValue = null }),
        ) {
            NewReceiptScreen(
                onBack = { navController.popBackStack() },
                onCreated = {
                    navController.navigate(Routes.HISTORY) {
                        popUpTo(Routes.APP)
                    }
                },
            )
        }
        composable(
            route = Routes.SUPPLIER_DETAIL,
            arguments = listOf(navArgument("id") { type = NavType.StringType }),
        ) {
            SupplierDetailScreen(onBack = { navController.popBackStack() })
        }
        composable(Routes.HISTORY) {
            HistoryScreen(
                onBack = { navController.popBackStack() },
                onOpenReturn = { id -> navController.navigate(Routes.receiptReturn(id)) },
            )
        }
        composable(
            route = Routes.RETURN,
            arguments = listOf(navArgument("receiptId") { type = NavType.StringType }),
        ) {
            ReturnScreen(
                onBack = { navController.popBackStack() },
                onDone = { navController.popBackStack() },
            )
        }
        composable(Routes.TO_BUY) {
            ToBuyScreen(
                onBack = { navController.popBackStack() },
                onCreateReceipt = { ids -> navController.navigate(Routes.newReceipt(ids.joinToString(","))) },
            )
        }
    }
}
