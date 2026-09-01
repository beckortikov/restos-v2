package com.restos.checkin.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.currentBackStackEntryAsState
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

    // startDestination ФИКСИРУЕМ на первом известном статусе.
    //
    // Если пересчитывать его на каждое изменение status, NavHost пересоздаёт
    // весь граф — и отказ в активации выглядел так: вход сохранил токен →
    // status стал LoggedIn → граф перескочил на экран отметок (мигание) →
    // проверка роли не прошла, logout → граф вернулся на PIN. Вместе с
    // уничтоженным back stack entry умирала и ViewModel, поэтому текст
    // «этот PIN не подходит» исчезал, не успев показаться.
    //
    // Дальше состоянием управляем навигацией, а не пересборкой графа.
    val startDestination = remember {
        when (status) {
            AuthStatus.NeedsOnboarding -> Routes.ONBOARDING
            AuthStatus.LoggedIn -> Routes.PUNCH
            else -> Routes.LOGIN
        }
    }

    // Разлогин «снаружи» (401 от кассы, сброс привязки) должен увести с
    // рабочего экрана сам. Но если мы уже на нужном маршруте — не трогаем
    // его: повторный navigate уничтожил бы экран вместе с показанной на нём
    // ошибкой.
    val currentRoute = navController.currentBackStackEntryAsState().value?.destination?.route
    LaunchedEffect(status, currentRoute) {
        val target = when (status) {
            AuthStatus.NeedsOnboarding -> Routes.ONBOARDING
            AuthStatus.LoggedOut -> Routes.LOGIN
            else -> null // LoggedIn: на PUNCH переводит сам экран активации
        }
        if (target != null && currentRoute != null && currentRoute != target) {
            navController.navigate(target) {
                popUpTo(navController.graph.id) { inclusive = true }
            }
        }
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
