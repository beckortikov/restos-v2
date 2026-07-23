package com.restos.zakup.data.net

import com.restos.zakup.data.receipts.ReceiptsApi
import com.restos.zakup.data.stock.StockApi
import com.restos.zakup.data.suppliers.SuppliersApi
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import retrofit2.Retrofit
import javax.inject.Singleton

/**
 * Доменные API закупщика поверх общего Retrofit из :core (CoreNetworkModule).
 * Инфраструктура (OkHttp/Json/Retrofit/интерцепторы/AuthApi) — в :core.
 */
@Module
@InstallIn(SingletonComponent::class)
object ZakupNetworkModule {

    @Provides
    @Singleton
    fun provideStockApi(retrofit: Retrofit): StockApi = retrofit.create(StockApi::class.java)

    @Provides
    @Singleton
    fun provideSuppliersApi(retrofit: Retrofit): SuppliersApi =
        retrofit.create(SuppliersApi::class.java)

    @Provides
    @Singleton
    fun provideReceiptsApi(retrofit: Retrofit): ReceiptsApi =
        retrofit.create(ReceiptsApi::class.java)
}
