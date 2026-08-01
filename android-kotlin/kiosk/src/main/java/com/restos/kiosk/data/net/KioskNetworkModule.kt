package com.restos.kiosk.data.net

import com.restos.kiosk.data.menu.MenuApi
import com.restos.kiosk.data.orders.CreateOrderApi
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
object KioskNetworkModule {

    @Provides
    @Singleton
    fun provideMenuApi(retrofit: Retrofit): MenuApi = retrofit.create(MenuApi::class.java)

    @Provides
    @Singleton
    fun provideCreateOrderApi(retrofit: Retrofit): CreateOrderApi =
        retrofit.create(CreateOrderApi::class.java)
}
