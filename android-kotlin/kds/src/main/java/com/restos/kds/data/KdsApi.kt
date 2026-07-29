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

    @POST("api/v1/kds/items/{id}/call-waiter")
    suspend fun callWaiter(@Path("id") id: String): CallWaiterResponse

    @GET("api/v1/kds/stations")
    suspend fun stations(): StationsResponse

    /** Меню — для экрана стоп-листа кухни (постранично, MaxLimit=200). */
    @GET("api/v1/menu/items")
    suspend fun menuItems(
        @Query("limit") limit: Int = 200,
        @Query("cursor") cursor: String? = null,
    ): MenuItemsResponse

    /** Поставить/снять ручной стоп на блюдо (повар: «закончилось»). */
    @POST("api/v1/stop-list/{id}/override")
    suspend fun setStopOverride(
        @Path("id") menuItemId: String,
        @Body body: StopOverrideRequest,
    ): MenuItemDto
}

interface BootstrapApi {
    @GET("api/v1/bootstrap/status")
    suspend fun status(): BootstrapStatusDto
}
