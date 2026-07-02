# KDS release R8 rules.

# Keep kotlinx.serialization @Serializable classes (:kds + :core DTO).
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt
-keep,includedescriptorclasses class com.restos.kds.**$$serializer { *; }
-keep,includedescriptorclasses class com.restos.core.**$$serializer { *; }
-keepclassmembers class com.restos.kds.** {
    *** Companion;
}
-keepclassmembers class com.restos.core.** {
    *** Companion;
}
-keepclasseswithmembers class com.restos.kds.** {
    kotlinx.serialization.KSerializer serializer(...);
}
-keepclasseswithmembers class com.restos.core.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# OkHttp / Retrofit
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn retrofit2.**
