# Keep kotlinx.serialization @Serializable classes
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt
-keep,includedescriptorclasses class com.restos.waiter.**$$serializer { *; }
-keepclassmembers class com.restos.waiter.** {
    *** Companion;
}
-keepclasseswithmembers class com.restos.waiter.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# OkHttp / Retrofit
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn retrofit2.**
