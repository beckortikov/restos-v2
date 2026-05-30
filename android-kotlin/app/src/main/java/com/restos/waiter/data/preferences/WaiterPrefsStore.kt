package com.restos.waiter.data.preferences

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import javax.inject.Inject
import javax.inject.Singleton

private val Context.waiterPrefsDataStore by preferencesDataStore(name = "waiter_prefs")

enum class ViewMode { List, Grid }
enum class HomeScreen { Tables, Menu }
enum class TablesTab { Mine, All }

@Singleton
class WaiterPrefsStore @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    val viewMode: Flow<ViewMode> = context.waiterPrefsDataStore.data.map { prefs ->
        if (prefs[KEY_VIEW_MODE] == "grid") ViewMode.Grid else ViewMode.List
    }

    val homeScreen: Flow<HomeScreen> = context.waiterPrefsDataStore.data.map { prefs ->
        if (prefs[KEY_HOME_SCREEN] == "menu") HomeScreen.Menu else HomeScreen.Tables
    }

    val tablesTab: Flow<TablesTab> = context.waiterPrefsDataStore.data.map { prefs ->
        if (prefs[KEY_TABLES_TAB] == "all") TablesTab.All else TablesTab.Mine
    }

    suspend fun setViewMode(mode: ViewMode) {
        context.waiterPrefsDataStore.edit { it[KEY_VIEW_MODE] = mode.name.lowercase() }
    }

    suspend fun setHomeScreen(screen: HomeScreen) {
        context.waiterPrefsDataStore.edit { it[KEY_HOME_SCREEN] = screen.name.lowercase() }
    }

    suspend fun setTablesTab(tab: TablesTab) {
        context.waiterPrefsDataStore.edit { it[KEY_TABLES_TAB] = tab.name.lowercase() }
    }

    private companion object {
        val KEY_VIEW_MODE = stringPreferencesKey("view_mode")
        val KEY_HOME_SCREEN = stringPreferencesKey("home_screen")
        val KEY_TABLES_TAB = stringPreferencesKey("tables_tab")
    }
}
