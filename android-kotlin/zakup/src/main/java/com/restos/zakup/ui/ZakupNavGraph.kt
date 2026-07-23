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
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.restos.zakup.ui.auth.AuthGateViewModel
import com.restos.zakup.ui.auth.AuthStatus
import com.restos.zakup.ui.login.PinLoginScreen
import com.restos.zakup.ui.onboarding.OnboardingScreen
import com.restos.zakup.ui.shell.ZakupShell

object Routes {
    const val ONBOARDING = "onboarding"
    const val LOGIN = "login"
    const val APP = "app"
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
            )
        }
    }
}
