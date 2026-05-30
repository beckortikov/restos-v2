package com.restos.waiter.data.drafts

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.Json
import javax.inject.Inject
import javax.inject.Singleton

private val Context.draftsDataStore by preferencesDataStore(name = "waiter_drafts")
private val KEY_DRAFTS = stringPreferencesKey("drafts_json")

@Singleton
class WaiterDraftStore @Inject constructor(
    @ApplicationContext private val context: Context,
    private val json: Json,
) {
    val draftsFlow: Flow<List<WaiterDraft>> = context.draftsDataStore.data.map { prefs ->
        decode(prefs[KEY_DRAFTS])
    }

    suspend fun current(): List<WaiterDraft> = draftsFlow.first()

    suspend fun upsert(draft: WaiterDraft) {
        context.draftsDataStore.edit { prefs ->
            val list = decode(prefs[KEY_DRAFTS])
                .filterNot { it.tableId == draft.tableId && it.waiterId == draft.waiterId }
            prefs[KEY_DRAFTS] = encode(list + draft)
        }
    }

    suspend fun delete(tableId: String, waiterId: String? = null) {
        context.draftsDataStore.edit { prefs ->
            val list = decode(prefs[KEY_DRAFTS]).filterNot { d ->
                d.tableId == tableId && (waiterId == null || d.waiterId == waiterId)
            }
            prefs[KEY_DRAFTS] = encode(list)
        }
    }

    suspend fun pruneByFreeTables(freeTableIds: Set<String>) {
        if (freeTableIds.isEmpty()) return
        context.draftsDataStore.edit { prefs ->
            val list = decode(prefs[KEY_DRAFTS]).filterNot { it.tableId in freeTableIds }
            prefs[KEY_DRAFTS] = encode(list)
        }
    }

    private fun decode(raw: String?): List<WaiterDraft> {
        if (raw.isNullOrBlank()) return emptyList()
        return runCatching {
            json.decodeFromString(kotlinx.serialization.builtins.ListSerializer(WaiterDraft.serializer()), raw)
        }.getOrDefault(emptyList())
    }

    private fun encode(list: List<WaiterDraft>): String =
        json.encodeToString(kotlinx.serialization.builtins.ListSerializer(WaiterDraft.serializer()), list)
}
