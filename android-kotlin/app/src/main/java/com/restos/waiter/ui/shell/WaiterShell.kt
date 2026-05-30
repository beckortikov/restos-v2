package com.restos.waiter.ui.shell

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Assignment
import androidx.compose.material.icons.outlined.GridView
import androidx.compose.material.icons.outlined.Logout
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.RestaurantMenu
import androidx.compose.material.icons.outlined.TableRestaurant
import androidx.compose.material.icons.outlined.ViewList
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.restos.waiter.data.preferences.HomeScreen
import com.restos.waiter.data.preferences.ViewMode
import com.restos.waiter.ui.lan.NetworkStatusDot

enum class WaiterTab(val route: String, val title: String) {
    Tables("tables", "Столы"),
    Orders("orders", "Заказы"),
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WaiterShell(
    currentTab: WaiterTab,
    onSelectTab: (WaiterTab) -> Unit,
    onRefresh: () -> Unit,
    onLoggedOut: () -> Unit,
    viewModel: WaiterShellViewModel = hiltViewModel(),
    content: @Composable () -> Unit,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val viewMode by viewModel.viewMode.collectAsStateWithLifecycle()
    val homeScreen by viewModel.homeScreen.collectAsStateWithLifecycle()
    val networkStatus by viewModel.networkStatus.collectAsStateWithLifecycle()
    var profileOpen by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            CenterAlignedTopAppBar(
                navigationIcon = {
                    IconButton(onClick = onRefresh) {
                        Icon(Icons.Outlined.Refresh, contentDescription = "Обновить")
                    }
                },
                title = {
                    Text(
                        state.me?.restaurant?.name ?: "RestOS",
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                },
                actions = {
                    Box(modifier = Modifier.padding(end = 8.dp)) {
                        AvatarButton(
                            initials = initialsFrom(state.me?.user?.displayName),
                            onClick = { profileOpen = true },
                        )
                        NetworkStatusDot(
                            status = networkStatus,
                            modifier = Modifier
                                .align(Alignment.TopEnd)
                                .padding(top = 2.dp, end = 2.dp),
                        )
                    }
                },
            )
        },
        bottomBar = {
            NavigationBar {
                listOf(
                    Triple(WaiterTab.Tables, Icons.Outlined.GridView, "Столы"),
                    Triple(WaiterTab.Orders, Icons.AutoMirrored.Outlined.Assignment, "Заказы"),
                ).forEach { (tab, icon, label) ->
                    NavigationBarItem(
                        selected = tab == currentTab,
                        onClick = { onSelectTab(tab) },
                        icon = { Icon(icon, contentDescription = label) },
                        label = { Text(label, fontSize = 11.sp) },
                    )
                }
            }
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { inner ->
        Box(Modifier.fillMaxSize().padding(inner)) {
            content()
        }
    }

    if (profileOpen) {
        val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        androidx.compose.runtime.LaunchedEffect(Unit) { viewModel.loadTodayStats() }
        ModalBottomSheet(
            onDismissRequest = { profileOpen = false },
            sheetState = sheetState,
        ) {
            ProfileSheetContent(
                userName = state.me?.user?.displayName ?: "Гость",
                role = state.me?.user?.role ?: "waiter",
                restaurantName = state.me?.restaurant?.name,
                todayOrders = state.todayStats?.ordersCount,
                todayServiceCharge = state.todayStats?.serviceCharge,
                viewMode = viewMode,
                homeScreen = homeScreen,
                onSetViewMode = viewModel::setViewMode,
                onSetHomeScreen = viewModel::setHomeScreen,
                onLogout = {
                    profileOpen = false
                    viewModel.logout(onLoggedOut)
                },
            )
        }
    }
}

@Composable
private fun AvatarButton(initials: String, onClick: () -> Unit) {
    Surface(
        modifier = Modifier.size(36.dp).padding(end = 0.dp),
        shape = CircleShape,
        color = MaterialTheme.colorScheme.primary.copy(alpha = 0.15f),
        onClick = onClick,
    ) {
        Box(contentAlignment = Alignment.Center) {
            Text(
                text = initials,
                color = MaterialTheme.colorScheme.primary,
                fontSize = 13.sp,
                fontWeight = FontWeight.Bold,
            )
        }
    }
}

@Composable
private fun ProfileSheetContent(
    userName: String,
    role: String,
    restaurantName: String?,
    todayOrders: Int?,
    todayServiceCharge: String?,
    viewMode: ViewMode,
    homeScreen: HomeScreen,
    onSetViewMode: (ViewMode) -> Unit,
    onSetHomeScreen: (HomeScreen) -> Unit,
    onLogout: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp)
            .padding(bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("Профиль", fontWeight = FontWeight.SemiBold, fontSize = 16.sp)

        Surface(
            shape = RoundedCornerShape(12.dp),
            color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Row(
                modifier = Modifier.padding(12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Surface(
                    shape = CircleShape,
                    color = MaterialTheme.colorScheme.primary.copy(alpha = 0.15f),
                    modifier = Modifier.size(48.dp),
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        Text(
                            initialsFrom(userName),
                            color = MaterialTheme.colorScheme.primary,
                            fontWeight = FontWeight.Bold,
                        )
                    }
                }
                Column(modifier = Modifier.fillMaxWidth()) {
                    Text(userName, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                    Text(
                        roleLabel(role),
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.65f),
                        fontSize = 13.sp,
                    )
                    restaurantName?.let {
                        Text(
                            it,
                            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f),
                            fontSize = 12.sp,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }

        SettingsSection(label = "Сегодня") {
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                StatCard(
                    label = "Заказов",
                    value = todayOrders?.toString() ?: "—",
                    accent = false,
                    modifier = Modifier.weight(1f),
                )
                StatCard(
                    label = "Обслуживание",
                    value = todayServiceCharge?.let { formatStatCurrency(it) } ?: "—",
                    accent = true,
                    modifier = Modifier.weight(1f),
                )
            }
        }

        SettingsSection(label = "Вид списка") {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                SegmentedButton(
                    label = "Список",
                    icon = Icons.Outlined.ViewList,
                    active = viewMode == ViewMode.List,
                    modifier = Modifier.weight(1f),
                    onClick = { onSetViewMode(ViewMode.List) },
                )
                SegmentedButton(
                    label = "Сетка",
                    icon = Icons.Outlined.GridView,
                    active = viewMode == ViewMode.Grid,
                    modifier = Modifier.weight(1f),
                    onClick = { onSetViewMode(ViewMode.Grid) },
                )
            }
        }

        SettingsSection(label = "Начинать с") {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                SegmentedButton(
                    label = "Столы",
                    icon = Icons.Outlined.TableRestaurant,
                    active = homeScreen == HomeScreen.Tables,
                    modifier = Modifier.weight(1f),
                    onClick = { onSetHomeScreen(HomeScreen.Tables) },
                )
                SegmentedButton(
                    label = "Меню",
                    icon = Icons.Outlined.RestaurantMenu,
                    active = homeScreen == HomeScreen.Menu,
                    modifier = Modifier.weight(1f),
                    onClick = { onSetHomeScreen(HomeScreen.Menu) },
                )
            }
        }

        TextButton(
            onClick = onLogout,
            modifier = Modifier.fillMaxWidth().height(48.dp),
        ) {
            Icon(Icons.Outlined.Logout, contentDescription = null, tint = MaterialTheme.colorScheme.error)
            Spacer(Modifier.size(8.dp))
            Text("Выйти", color = MaterialTheme.colorScheme.error, fontWeight = FontWeight.Medium)
        }
    }
}

@Composable
private fun SettingsSection(label: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            label.uppercase(),
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = 0.8.sp,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f),
        )
        content()
    }
}

@Composable
private fun SegmentedButton(
    label: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    active: Boolean,
    modifier: Modifier,
    onClick: () -> Unit,
) {
    Surface(
        modifier = modifier.height(44.dp),
        shape = RoundedCornerShape(10.dp),
        color = if (active) MaterialTheme.colorScheme.primary
        else MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
        onClick = onClick,
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.Center,
        ) {
            Icon(
                icon,
                contentDescription = null,
                tint = if (active) MaterialTheme.colorScheme.onPrimary
                else MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.size(18.dp),
            )
            Spacer(Modifier.size(6.dp))
            Text(
                label,
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
                color = if (active) MaterialTheme.colorScheme.onPrimary
                else MaterialTheme.colorScheme.onSurface,
            )
        }
    }
}

@Composable
private fun StatCard(
    label: String,
    value: String,
    accent: Boolean,
    modifier: Modifier,
) {
    val bg = if (accent) androidx.compose.ui.graphics.Color(0xFFFEF3C7)
    else MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)
    val fg = if (accent) androidx.compose.ui.graphics.Color(0xFF92400E)
    else MaterialTheme.colorScheme.onSurface
    Surface(modifier = modifier, shape = RoundedCornerShape(12.dp), color = bg) {
        androidx.compose.foundation.layout.Column(
            modifier = Modifier.padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(
                label,
                fontSize = 11.sp,
                color = fg.copy(alpha = 0.7f),
            )
            Text(value, fontSize = 18.sp, fontWeight = FontWeight.Bold, color = fg)
        }
    }
}

private fun formatStatCurrency(raw: String): String {
    val v = runCatching { java.math.BigDecimal(raw) }.getOrNull()
        ?: return raw
    return com.restos.waiter.util.formatCurrency(v)
}

private fun initialsFrom(name: String?): String {
    if (name.isNullOrBlank()) return "??"
    return name.split(Regex("\\s+"))
        .mapNotNull { it.firstOrNull()?.uppercaseChar() }
        .take(2)
        .joinToString("")
        .ifBlank { "??" }
}

private fun roleLabel(role: String): String = when (role.lowercase()) {
    "waiter" -> "Официант"
    "cashier" -> "Кассир"
    "cook" -> "Повар"
    "manager" -> "Менеджер"
    "owner" -> "Владелец"
    else -> role.replaceFirstChar { it.uppercase() }
}
