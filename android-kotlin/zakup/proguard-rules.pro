# Keep kotlinx.serialization @Serializable classes
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt

# Приложение закупщика — DTO в com.restos.zakup.**
-keep,includedescriptorclasses class com.restos.zakup.**$$serializer { *; }
-keepclassmembers class com.restos.zakup.** {
    *** Companion;
}
-keepclasseswithmembers class com.restos.zakup.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# Общий модуль :core — DTO логина/авторизации/конвертов/событий в
# com.restos.core.** (AuthApi, ApiEnvelope, PagedEnvelope, MachineInfoProbe,
# ServerEvent payloads). Без этого R8 может выкинуть их $$serializer и release
# упадёт в рантайме на десериализации ответа сервера.
-keep,includedescriptorclasses class com.restos.core.**$$serializer { *; }
-keepclassmembers class com.restos.core.** {
    *** Companion;
}
-keepclasseswithmembers class com.restos.core.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# OkHttp / Retrofit
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn retrofit2.**
