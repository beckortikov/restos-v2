package com.restos.zakup.data.stock

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import retrofit2.http.Body
import retrofit2.http.POST
import retrofit2.http.Path

/**
 * Складские операции закупщика (write): списание, инвентаризация, начальный
 * остаток, расход хозтоваров, возврат поставщику. Контракт — openapi tag stock.
 * Idempotency-Key — авто (core-интерцептор).
 */
interface OperationsApi {
    @POST("api/v1/stock/writeoffs")
    suspend fun createWriteoff(@Body body: WriteoffInput): WriteoffResult

    @POST("api/v1/stock/inventory")
    suspend fun createInventory(@Body body: InventoryInput): InventoryCheckDto

    @POST("api/v1/stock/inventory/{id}/apply")
    suspend fun applyInventory(@Path("id") id: String): InventoryCheckDto

    @POST("api/v1/stock/opening-balance")
    suspend fun openingBalance(@Body body: OpeningBalanceInput): OpeningBalanceResult

    @POST("api/v1/supply-expenses")
    suspend fun createSupplyExpense(@Body body: SupplyExpenseInput): SupplyExpenseDto

    @POST("api/v1/stock/returns")
    suspend fun createReturn(@Body body: ReturnInput): ReturnResult
}

@Serializable
data class WriteoffInput(
    val reason: String,
    val description: String? = null,
    val lines: List<WriteoffLineInput>,
)

@Serializable
data class WriteoffLineInput(
    @SerialName("ingredient_id") val ingredientId: String,
    val name: String,
    val qty: String,
    val unit: String? = null,
    val cost: String,
)

@Serializable
data class WriteoffResult(val id: String? = null, @SerialName("total_cost") val totalCost: String = "0")

@Serializable
data class InventoryInput(
    val note: String? = null,
    val lines: List<InventoryLineInput>,
)

@Serializable
data class InventoryLineInput(
    @SerialName("ingredient_id") val ingredientId: String,
    @SerialName("actual_qty") val actualQty: String,
)

@Serializable
data class InventoryCheckDto(
    val id: String,
    val status: String = "draft",
    @SerialName("total_items") val totalItems: Int = 0,
    @SerialName("items_with_diff") val itemsWithDiff: Int = 0,
)

@Serializable
data class OpeningBalanceInput(
    val note: String? = null,
    val lines: List<OpeningBalanceLineInput>,
)

@Serializable
data class OpeningBalanceLineInput(
    @SerialName("ingredient_id") val ingredientId: String,
    val qty: String,
    val price: String,
)

@Serializable
data class OpeningBalanceResult(
    val applied: Int = 0,
    @SerialName("inventory_value") val inventoryValue: String = "0",
)

@Serializable
data class SupplyExpenseInput(
    @SerialName("ingredient_id") val ingredientId: String,
    val qty: String,
    val unit: String? = null,
    val reason: String? = null,
    @SerialName("issued_to") val issuedTo: String? = null,
    val note: String? = null,
)

@Serializable
data class SupplyExpenseDto(val id: String)

@Serializable
data class ReturnInput(
    @SerialName("receipt_id") val receiptId: String,
    val date: String? = null,
    val reason: String,             // spoilage | breakage | expired | other
    val note: String? = null,
    @SerialName("refund_type") val refundType: String, // debt | money
    @SerialName("account_id") val accountId: String? = null,
    val lines: List<ReturnLineInput>,
)

@Serializable
data class ReturnLineInput(
    @SerialName("receipt_line_id") val receiptLineId: String,
    val qty: String,
)

@Serializable
data class ReturnResult(val id: String? = null)
