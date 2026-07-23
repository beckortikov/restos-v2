package com.restos.zakup.data.suppliers

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import retrofit2.http.GET
import retrofit2.http.Query

/** Поставщики. Контракт — openapi tag admin, модель suppliers. */
interface SuppliersApi {
    @GET("api/v1/suppliers")
    suspend fun listSuppliers(
        @Query("limit") limit: Int = 200,
    ): SuppliersEnvelope
}

@Serializable
data class SuppliersEnvelope(val data: List<SupplierDto> = emptyList())

@Serializable
data class SupplierDto(
    val id: String,
    val name: String = "",
    @SerialName("contact_person") val contactPerson: String? = null,
    val phone: String? = null,
    val categories: List<String> = emptyList(),
    @SerialName("payment_terms_days") val paymentTermsDays: Int = 0,
    @SerialName("credit_limit") val creditLimit: String = "0",
    @SerialName("current_debt") val currentDebt: String = "0",
)
