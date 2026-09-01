package com.restos.checkin.data.attendance

import com.restos.core.common.ListEnvelope
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST

/**
 * Отметки прихода/ухода. Запрос идёт под токеном УСТРОЙСТВА (роль checkin),
 * сотрудник опознаётся PIN-ом в теле — отметка не создаёт сессию и не трогает
 * токен планшета.
 *
 * PIN всегда в body, никогда в query: строка запроса оседает в логах.
 */
interface AttendanceApi {

    @POST("api/v1/attendance/lookup")
    suspend fun lookup(@Body body: PinBody): AttendanceLookupDto

    @POST("api/v1/attendance/punch")
    suspend fun punch(@Body body: PunchBody): AttendancePunchDto

    @GET("api/v1/attendance/on-shift")
    suspend fun onShift(): ListEnvelope<OnShiftRowDto>
}

@Serializable
data class PinBody(val pin: String)

@Serializable
data class PunchBody(val pin: String, val action: String)

@Serializable
data class AttendanceLookupDto(
    @SerialName("user_id") val userId: String,
    @SerialName("user_name") val userName: String,
    val position: String = "",
    val role: String = "",
    /** "in" — предложить приход, "out" — уход (смена открыта). */
    @SerialName("next_action") val nextAction: String,
    @SerialName("on_shift_since") val onShiftSince: String? = null,
    @SerialName("worked_minutes") val workedMinutes: Int = 0,
)

@Serializable
data class AttendancePunchDto(
    val action: String,
    @SerialName("entry_id") val entryId: String,
    @SerialName("user_id") val userId: String,
    @SerialName("user_name") val userName: String,
    val at: String,
    @SerialName("worked_minutes") val workedMinutes: Int = 0,
    /** Непустой — значит вчерашняя смена была закрыта автоматически. */
    @SerialName("closed_stale_entry_id") val closedStaleEntryId: String = "",
)

@Serializable
data class OnShiftRowDto(
    @SerialName("entry_id") val entryId: String,
    @SerialName("user_id") val userId: String,
    @SerialName("user_name") val userName: String = "",
    @SerialName("clock_in") val clockIn: String,
    @SerialName("worked_minutes") val workedMinutes: Int = 0,
)
