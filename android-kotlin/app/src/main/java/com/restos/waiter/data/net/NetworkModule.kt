package com.restos.waiter.data.net

import com.restos.waiter.data.kitchen.KitchenApi
import com.restos.waiter.data.menu.MenuApi
import com.restos.waiter.data.orders.CreateOrderApi
import com.restos.waiter.data.orders.OrdersApi
import com.restos.waiter.data.tables.TablesApi
import com.restos.waiter.data.update.WaiterAppApi
import com.restos.waiter.data.users.UsersApi
import com.restos.waiter.data.onboarding.LicenseApi
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import retrofit2.Retrofit
import javax.inject.Singleton

/**
 * NetworkModule (официант) — провайдеры доменных API поверх общего Retrofit
 * из :core (CoreNetworkModule). Инфраструктура (OkHttp/Json/Retrofit/AuthApi/
 * интерцепторы) вынесена в :core и переиспользуется приложением кухни (:kds).
 */
@Module
@InstallIn(SingletonComponent::class)
object NetworkModule {

    @Provides
    @Singleton
    fun provideTablesApi(retrofit: Retrofit): TablesApi = retrofit.create(TablesApi::class.java)

    @Provides
    @Singleton
    fun provideOrdersApi(retrofit: Retrofit): OrdersApi = retrofit.create(OrdersApi::class.java)

    @Provides
    @Singleton
    fun provideUsersApi(retrofit: Retrofit): UsersApi = retrofit.create(UsersApi::class.java)

    @Provides
    @Singleton
    fun provideMenuApi(retrofit: Retrofit): MenuApi = retrofit.create(MenuApi::class.java)

    @Provides
    @Singleton
    fun provideCreateOrderApi(retrofit: Retrofit): CreateOrderApi =
        retrofit.create(CreateOrderApi::class.java)

    @Provides
    @Singleton
    fun provideKitchenApi(retrofit: Retrofit): KitchenApi =
        retrofit.create(KitchenApi::class.java)

    @Provides
    @Singleton
    fun provideLicenseApi(retrofit: Retrofit): LicenseApi =
        retrofit.create(LicenseApi::class.java)

    @Provides
    @Singleton
    fun provideWaiterAppApi(retrofit: Retrofit): WaiterAppApi =
        retrofit.create(WaiterAppApi::class.java)
}
