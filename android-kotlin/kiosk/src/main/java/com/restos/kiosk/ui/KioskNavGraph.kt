package com.restos.kiosk.ui

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
import com.restos.kiosk.ui.auth.AuthGateViewModel
import com.restos.kiosk.ui.auth.AuthStatus
import com.restos.kiosk.ui.confirm.OrderConfirmedScreen
import com.restos.kiosk.ui.login.PinLoginScreen
import com.restos.kiosk.ui.menu.MenuScreen
import com.restos.kiosk.ui.onboarding.OnboardingScreen
import com.restos.kiosk.ui.welcome.WelcomeScreen

object Routes {
    const val ONBOARDING = "onboarding"
    const val LOGIN = "login"
    const val WELCOME = "welcome"
    const val MENU = "menu/{orderType}"
    const val CONFIRM = "confirm?orderNumber={orderNumber}"

    fun menu(orderType: String) = "menu/$orderType"
    fun confirm(orderNumber: Int?) = "confirm?orderNumber=${orderNumber ?: ""}"
}

@Composable
fun KioskNavGraph(
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
        AuthStatus.LoggedIn -> Routes.WELCOME
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
                    navController.navigate(Routes.WELCOME) {
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
        composable(Routes.WELCOME) {
            WelcomeScreen(
                onSelectOrderType = { orderType ->
                    navController.navigate(Routes.menu(orderType))
                },
                onStaffLogout = {
                    navController.navigate(Routes.LOGIN) {
                        popUpTo(Routes.WELCOME) { inclusive = true }
                    }
                },
            )
        }
        composable(
            route = Routes.MENU,
            arguments = listOf(navArgument("orderType") { type = NavType.StringType }),
        ) {
            MenuScreen(
                onOrderCreated = { orderNumber ->
                    navController.navigate(Routes.confirm(orderNumber)) {
                        popUpTo(Routes.WELCOME) { inclusive = false }
                    }
                },
                onCancel = { navController.popBackStack() },
            )
        }
        composable(
            route = Routes.CONFIRM,
            arguments = listOf(
                navArgument("orderNumber") { type = NavType.StringType; defaultValue = "" },
            ),
        ) { entry ->
            val orderNumber = entry.arguments?.getString("orderNumber")?.toIntOrNull()
            OrderConfirmedScreen(
                orderNumber = orderNumber,
                onDone = {
                    navController.navigate(Routes.WELCOME) {
                        popUpTo(Routes.WELCOME) { inclusive = true }
                    }
                },
            )
        }
    }
}
