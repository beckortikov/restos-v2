package com.restos.kds.data

import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query

interface KdsApi {
    @GET("api/v1/kds/items")
    suspend fun list(
        @Query("stations") stations: String? = null,
        @Query("status") status: String? = null,
    ): KdsListResponse

    @POST("api/v1/kds/items/{id}/status")
    suspend fun setStatus(@Path("id") id: String, @Body body: SetStatusRequest): KdsItemDto
}

interface BootstrapApi {
    @GET("api/v1/bootstrap/status")
    suspend fun status(): BootstrapStatusDto
}
