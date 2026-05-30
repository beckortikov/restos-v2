package com.restos.waiter.data.users

import com.restos.waiter.data.auth.UserDto
import com.restos.waiter.data.common.PagedEnvelope
import retrofit2.http.GET

interface UsersApi {
    @GET("api/v1/users")
    suspend fun listUsers(): PagedEnvelope<UserDto>
}
