package com.restos.waiter.data.events

import com.restos.waiter.data.auth.TokenStore
import com.restos.waiter.data.config.ServerConfigStore
import com.restos.waiter.data.net.NetworkConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import java.util.concurrent.TimeUnit
import javax.inject.Inject
import javax.inject.Singleton

/**
 * v4 SSE: `GET /api/v1/events` (без trailing slash). Сервер шлёт типизованные
 * фреймы:
 *   event: order.created
 *   data: {"id":"<uuid>","status":"new","total":"0"}
 *
 *   event: order.updated
 *   data: {"id":"<uuid>","status":"bill_requested","waiter_id":"<uuid>"}
 *
 *   event: table.updated
 *   data: {"id":"<uuid>"}
 *
 * Автоматически переподключается с back-off.
 */
@Singleton
class EventStreamClient @Inject constructor(
    private val tokenStore: TokenStore,
    @Suppress("UNUSED_PARAMETER") private val config: NetworkConfig,
    private val serverConfig: ServerConfigStore,
    private val bus: EventBus,
    private val json: Json,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var loopJob: Job? = null
    private var currentSource: EventSource? = null

    @Synchronized
    fun start() {
        if (loopJob?.isActive == true) return
        loopJob = scope.launch { runReconnectLoop() }
    }

    @Synchronized
    fun stop() {
        loopJob?.cancel()
        loopJob = null
        currentSource?.cancel()
        currentSource = null
    }

    private suspend fun runReconnectLoop() {
        var backoffMs = 1000L
        while (scope.isActive) {
            val token = tokenStore.currentToken()
            val baseUrl = serverConfig.current()
            if (token.isNullOrBlank() || baseUrl.isNullOrBlank()) {
                delay(2000)
                continue
            }

            val request = Request.Builder()
                .url("${baseUrl}api/v1/events")
                .header("Accept", "text/event-stream")
                .header("Authorization", "Bearer $token")
                .build()

            val factory = EventSources.createFactory(buildSseClient())
            val terminated = kotlinx.coroutines.CompletableDeferred<Unit>()
            val source = factory.newEventSource(
                request,
                Listener(bus, json) { terminated.complete(Unit) },
            )
            currentSource = source

            terminated.await()
            currentSource = null

            if (!scope.isActive) return
            delay(backoffMs)
            backoffMs = (backoffMs * 2).coerceAtMost(MAX_BACKOFF_MS)
        }
    }

    private fun buildSseClient(): OkHttpClient =
        // read-таймаут 0 = unlimited (long-poll friendly).
        OkHttpClient.Builder()
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .retryOnConnectionFailure(true)
            .build()

    private companion object {
        const val MAX_BACKOFF_MS = 30_000L
    }
}

private class Listener(
    private val bus: EventBus,
    private val json: Json,
    private val onTerminate: () -> Unit,
) : EventSourceListener() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    override fun onOpen(eventSource: EventSource, response: Response) { /* reconnect внешним loop'ом */ }

    override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
        val evt = parse(type, data) ?: return
        scope.launch { bus.emit(evt) }
    }

    override fun onClosed(eventSource: EventSource) { onTerminate() }
    override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
        onTerminate()
    }

    private fun parse(type: String?, data: String): ServerEvent? {
        val t = type ?: return null
        return when (t) {
            "resync", "ping" -> ServerEvent.Resync.takeIf { t == "resync" }
            "order.created", "order.updated" -> {
                val payload = parseJson(data)
                val orderId = payload.string("id") ?: payload.string("order_id")
                val waiterId = payload.string("waiter_id")
                val status = payload.string("status")
                if (orderId == null) ServerEvent.Other(t)
                else if (t == "order.created") ServerEvent.OrderCreated(orderId, waiterId)
                else ServerEvent.OrderUpdated(orderId, waiterId, status)
            }
            "table.updated" -> {
                val payload = parseJson(data)
                val tableId = payload.string("id") ?: payload.string("table_id")
                if (tableId == null) ServerEvent.Other(t)
                else ServerEvent.TableUpdated(tableId)
            }
            else -> ServerEvent.Other(t)
        }
    }

    private fun parseJson(data: String): JsonObject =
        runCatching { json.parseToJsonElement(data) as JsonObject }
            .getOrDefault(JsonObject(emptyMap()))

    private fun JsonObject.string(key: String): String? =
        runCatching { this[key]?.jsonPrimitive?.content }.getOrNull()
}
