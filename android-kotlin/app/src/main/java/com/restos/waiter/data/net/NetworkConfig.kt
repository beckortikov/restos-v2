package com.restos.waiter.data.net

/**
 * Placeholder base URL для Retrofit. Реальный host:port подменяется на
 * каждом запросе через [HostRedirectInterceptor] из [ServerConfigStore].
 */
data class NetworkConfig(val baseUrl: String)
