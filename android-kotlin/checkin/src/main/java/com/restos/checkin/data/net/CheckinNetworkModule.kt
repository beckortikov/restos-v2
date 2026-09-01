package com.restos.checkin.data.net

import com.restos.checkin.data.attendance.AttendanceApi
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import retrofit2.Retrofit
import javax.inject.Singleton

/**
 * Доменные API терминала поверх общего Retrofit из :core (CoreNetworkModule).
 * Инфраструктура (OkHttp/Json/Retrofit/интерцепторы/AuthApi) — в :core.
 */
@Module
@InstallIn(SingletonComponent::class)
object CheckinNetworkModule {

    @Provides
    @Singleton
    fun provideAttendanceApi(retrofit: Retrofit): AttendanceApi =
        retrofit.create(AttendanceApi::class.java)
}
