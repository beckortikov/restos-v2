package com.restos.waiter.data.net

import com.restos.waiter.BuildConfig
import com.restos.waiter.data.auth.AuthApi
import com.restos.waiter.data.kitchen.KitchenApi
import com.restos.waiter.data.menu.MenuApi
import com.restos.waiter.data.orders.CreateOrderApi
import com.restos.waiter.data.orders.OrdersApi
import com.restos.waiter.data.tables.TablesApi
import com.restos.waiter.data.users.UsersApi
import com.restos.waiter.data.onboarding.LicenseApi
import com.jakewharton.retrofit2.converter.kotlinx.serialization.asConverterFactory
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object NetworkModule {

    @Provides
    @Singleton
    fun provideJson(): Json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        explicitNulls = false
    }

    @Provides
    @Singleton
    fun provideNetworkConfig(): NetworkConfig =
        // Placeholder для Retrofit. Реальный host подменяется
        // HostRedirectInterceptor из ServerConfigStore.
        NetworkConfig(baseUrl = "http://placeholder.invalid/")

    @Provides
    @Singleton
    fun provideOkHttpClient(
        hostRedirect: HostRedirectInterceptor,
        authInterceptor: AuthInterceptor,
        idempotencyInterceptor: IdempotencyInterceptor,
    ): OkHttpClient {
        val logging = HttpLoggingInterceptor().apply {
            level = if (BuildConfig.DEBUG) {
                HttpLoggingInterceptor.Level.BODY
            } else {
                HttpLoggingInterceptor.Level.NONE
            }
        }
        return OkHttpClient.Builder()
            // host-redirect должен быть ПЕРВЫМ — все остальные интерцепторы
            // увидят уже подменённый URL.
            .addInterceptor(hostRedirect)
            .addInterceptor(authInterceptor)
            .addInterceptor(idempotencyInterceptor)
            .addInterceptor(logging)
            // v4: refresh нет — Authenticator не нужен. На 401 AuthInterceptor
            // сам чистит токен; UI получает 401 и редиректит на PIN.
            .build()
    }

    @Provides
    @Singleton
    fun provideRetrofit(client: OkHttpClient, json: Json, config: NetworkConfig): Retrofit {
        val contentType = "application/json".toMediaType()
        return Retrofit.Builder()
            .baseUrl(config.baseUrl)
            .client(client)
            .addConverterFactory(json.asConverterFactory(contentType))
            .build()
    }

    @Provides @Singleton
    fun provideAuthApi(retrofit: Retrofit): AuthApi = retrofit.create(AuthApi::class.java)

    @Provides @Singleton
    fun provideTablesApi(retrofit: Retrofit): TablesApi = retrofit.create(TablesApi::class.java)

    @Provides @Singleton
    fun provideOrdersApi(retrofit: Retrofit): OrdersApi = retrofit.create(OrdersApi::class.java)

    @Provides @Singleton
    fun provideUsersApi(retrofit: Retrofit): UsersApi = retrofit.create(UsersApi::class.java)

    @Provides @Singleton
    fun provideMenuApi(retrofit: Retrofit): MenuApi = retrofit.create(MenuApi::class.java)

    @Provides @Singleton
    fun provideCreateOrderApi(retrofit: Retrofit): CreateOrderApi =
        retrofit.create(CreateOrderApi::class.java)

    @Provides @Singleton
    fun provideKitchenApi(retrofit: Retrofit): KitchenApi =
        retrofit.create(KitchenApi::class.java)

    @Provides @Singleton
    fun provideLicenseApi(retrofit: Retrofit): LicenseApi =
        retrofit.create(LicenseApi::class.java)
}
