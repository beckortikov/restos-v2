package com.restos.zakup.data.receipts

import com.restos.core.common.PagedEnvelope
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import retrofit2.http.GET
import retrofit2.http.Query

/** Приёмки. Контракт — openapi tag stock, модель stock_receipts. */
interface ReceiptsApi {
    @GET("api/v1/stock/receipts")
    suspend fun listReceipts(
        @Query("supplier_id") supplierId: String? = null,
        @Query("include") include: String? = null,
        @Query("limit") limit: Int = 100,
        @Query("cursor") cursor: String? = null,
    ): PagedEnvelope<StockReceiptDto>
}

@Serializable
data class StockReceiptDto(
    val id: String,
    @SerialName("supplier_id") val supplierId: String? = null,
    @SerialName("supplier_name") val supplierName: String? = null,
    val date: String? = null,
    @SerialName("total_amount") val totalAmount: String = "0",
    @SerialName("payment_type") val paymentType: String? = null,
    @SerialName("paid_amount") val paidAmount: String = "0",
    @SerialName("debt_amount") val debtAmount: String = "0",
    @SerialName("due_date") val dueDate: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
    val lines: List<ReceiptLineDto>? = null,
)

@Serializable
data class ReceiptLineDto(
    val id: String? = null,
    @SerialName("ingredient_id") val ingredientId: String? = null,
    val name: String? = null,
    val qty: String = "0",
    val unit: String? = null,
    @SerialName("price_per_unit") val pricePerUnit: String = "0",
)
