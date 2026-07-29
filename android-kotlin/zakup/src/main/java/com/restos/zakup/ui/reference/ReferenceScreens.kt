package com.restos.zakup.ui.reference

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Category
import androidx.compose.material.icons.outlined.Warehouse
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.restos.zakup.data.stock.StockApi
import com.restos.zakup.data.stock.listAllIngredients
import com.restos.zakup.ui.components.EmptyState
import com.restos.zakup.ui.components.ErrorState
import com.restos.zakup.ui.components.IconTile
import com.restos.zakup.ui.components.LoadingState
import com.restos.zakup.ui.components.ZakupCard
import com.restos.zakup.ui.components.ZakupTopBar
import com.restos.zakup.ui.theme.ZakupColors
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

// ─── Склады ───────────────────────────────────────────────────────────────

data class WarehouseItem(val id: String, val name: String, val kindLabel: String, val count: Int)
data class WarehousesUiState(val loading: Boolean = true, val error: String? = null, val items: List<WarehouseItem> = emptyList())

@HiltViewModel
class WarehousesViewModel @Inject constructor(private val api: StockApi) : ViewModel() {
    private val _state = MutableStateFlow(WarehousesUiState())
    val state: StateFlow<WarehousesUiState> = _state.asStateFlow()
    init { load() }
    fun load() {
        _state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            runCatching {
                val whD = async { api.listWarehouses().data }
                val ingD = async { api.listAllIngredients() }
                whD.await() to ingD.await()
            }.onSuccess { (whs, ings) ->
                val countBy = ings.groupingBy { it.warehouseId }.eachCount()
                _state.update {
                    it.copy(loading = false, items = whs.map { w ->
                        WarehouseItem(w.id, w.name.ifBlank { kindRu(w.kind) }, kindRu(w.kind), countBy[w.id] ?: 0)
                    })
                }
            }.onFailure { e -> _state.update { it.copy(loading = false, error = e.message ?: "Ошибка загрузки") } }
        }
    }
}

private fun kindRu(kind: String) = when (kind) {
    "products" -> "Продукты"; "purchased" -> "Покупные"; "supplies" -> "Хозтовары"; else -> "Склад"
}

@Composable
fun WarehousesScreen(onBack: () -> Unit, viewModel: WarehousesViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        ZakupTopBar("Склады", onBack = onBack)
        when {
            state.loading -> LoadingState()
            state.error != null -> ErrorState(state.error!!, onRetry = viewModel::load)
            state.items.isEmpty() -> EmptyState("Складов нет")
            else -> LazyColumn(
                contentPadding = PaddingValues(horizontal = 20.dp, vertical = 4.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                items(state.items, key = { it.id }) { w ->
                    ZakupCard(Modifier.fillMaxWidth(), padding = 14) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            IconTile(Icons.Outlined.Warehouse, ZakupColors.Primary, ZakupColors.PrimarySoft, 40)
                            Spacer(Modifier.size(12.dp))
                            Column(Modifier.weight(1f)) {
                                Text(w.name, style = MaterialTheme.typography.titleMedium)
                                Spacer(Modifier.size(2.dp))
                                Text(w.kindLabel, fontSize = 12.5.sp, color = ZakupColors.TextTertiary)
                            }
                            Text("${w.count} поз.", fontSize = 13.sp, color = ZakupColors.TextSecondary)
                        }
                    }
                }
            }
        }
    }
}

// ─── Категории ингредиентов ─────────────────────────────────────────────────

data class CategoriesUiState(val loading: Boolean = true, val error: String? = null, val items: List<Pair<String, Int>> = emptyList())

@HiltViewModel
class CategoriesViewModel @Inject constructor(private val api: StockApi) : ViewModel() {
    private val _state = MutableStateFlow(CategoriesUiState())
    val state: StateFlow<CategoriesUiState> = _state.asStateFlow()
    init { load() }
    fun load() {
        _state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            runCatching {
                val catD = async { runCatching { api.listCategories().data }.getOrDefault(emptyList()) }
                val ingD = async { api.listAllIngredients() }
                catD.await() to ingD.await()
            }.onSuccess { (cats, ings) ->
                val countBy = ings.groupingBy { it.category ?: "—" }.eachCount()
                val list = (if (cats.isNotEmpty()) cats else countBy.keys.toList()).sorted()
                _state.update { it.copy(loading = false, items = list.map { c -> c to (countBy[c] ?: 0) }) }
            }.onFailure { e -> _state.update { it.copy(loading = false, error = e.message ?: "Ошибка загрузки") } }
        }
    }
}

@Composable
fun CategoriesScreen(onBack: () -> Unit, viewModel: CategoriesViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        ZakupTopBar("Категории ингредиентов", onBack = onBack)
        when {
            state.loading -> LoadingState()
            state.error != null -> ErrorState(state.error!!, onRetry = viewModel::load)
            state.items.isEmpty() -> EmptyState("Категорий нет")
            else -> LazyColumn(
                contentPadding = PaddingValues(horizontal = 20.dp, vertical = 4.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                items(state.items, key = { it.first }) { (name, count) ->
                    ZakupCard(Modifier.fillMaxWidth(), padding = 14) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            IconTile(Icons.Outlined.Category, ZakupColors.TextSecondary, ZakupColors.SurfaceMuted, 40)
                            Spacer(Modifier.size(12.dp))
                            Text(name, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                            Text("$count поз.", fontSize = 13.sp, color = ZakupColors.TextSecondary)
                        }
                    }
                }
            }
        }
    }
}
