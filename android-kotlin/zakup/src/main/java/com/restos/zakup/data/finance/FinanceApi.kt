package com.restos.zakup.data.finance

import com.restos.core.common.PagedEnvelope
import kotlinx.serialization.Serializable
import retrofit2.http.GET

/** Финансовые счета (для выбора счёта оплаты приёмки / погашения долга). */
interface FinanceApi {
    @GET("api/v1/finance/accounts")
    suspend fun listAccounts(): PagedEnvelope<AccountDto>
}

@Serializable
data class AccountDto(
    val id: String,
    val name: String = "",
    val type: String = "",
    val balance: String = "0",
)
