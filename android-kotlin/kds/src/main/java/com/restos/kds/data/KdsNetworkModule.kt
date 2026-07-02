package com.restos.kds.data

import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import retrofit2.Retrofit
import javax.inject.Singleton

/** Провайдеры KDS-API поверх общего Retrofit из :core (CoreNetworkModule). */
@Module
@InstallIn(SingletonComponent::class)
object KdsNetworkModule {

    @Provides
    @Singleton
    fun provideKdsApi(retrofit: Retrofit): KdsApi = retrofit.create(KdsApi::class.java)

    @Provides
    @Singleton
    fun provideBootstrapApi(retrofit: Retrofit): BootstrapApi = retrofit.create(BootstrapApi::class.java)
}
