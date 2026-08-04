package com.restos.kiosk.data.shifts

import kotlinx.serialization.Serializable
import retrofit2.http.GET

/**
 * v4: `GET /api/v1/shifts/active` — 404, если кассир ещё не открыл смену.
 *
 * ВАЖНО: заказ обязан нести `shift_id` текущей смены уже при СОЗДАНИИ
 * (см. app/pos2/order/page.tsx::createOrder — `shiftId: shift.id`), а не
 * получать его позже при закрытии. `orders_write.go::Create()` пишет ровно
 * то, что прислал клиент (нет server-side fallback на активную смену) — без
 * shift_id заказ создаётся, но НЕ виден в списке "Заказы" (он там строго
 * скоупится по shift_id текущей смены), и его физически нельзя ни открыть,
 * ни отменить, ни закрыть из кассы. Проверено вживую 2026-08-02.
 */
interface ShiftsApi {
    @GET("api/v1/shifts/active")
    suspend fun active(): ActiveShiftDto
}

@Serializable
data class ActiveShiftDto(
    val id: String,
    val status: String = "open",
)
