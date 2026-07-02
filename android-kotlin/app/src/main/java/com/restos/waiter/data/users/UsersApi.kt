package com.restos.waiter.data.users

import com.restos.core.auth.UserDto
import com.restos.core.common.PagedEnvelope
import retrofit2.http.GET

interface UsersApi {
    @GET("api/v1/users")
    suspend fun listUsers(): PagedEnvelope<UserDto>
}
