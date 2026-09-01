package com.restos.checkin.ui

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
import com.restos.checkin.ui.auth.AuthGateViewModel
import com.restos.checkin.ui.auth.AuthStatus
import com.restos.checkin.ui.punch.PunchScreen
import com.restos.checkin.ui.login.PinLoginScreen
import com.restos.checkin.ui.onboarding.OnboardingScreen

object Routes {
    const val ONBOARDING = "onboarding"
    const val LOGIN = "login"
    const val PUNCH = "punch"
}

@Composable
fun CheckinNavGraph(
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
        AuthStatus.LoggedIn -> Routes.PUNCH
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
                    navController.navigate(Routes.PUNCH) {
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
        composable(Routes.PUNCH) {
            PunchScreen(
                onLoggedOut = {
                    navController.navigate(Routes.LOGIN) {
                        popUpTo(Routes.PUNCH) { inclusive = true }
                    }
                },
            )
        }
    }
}
