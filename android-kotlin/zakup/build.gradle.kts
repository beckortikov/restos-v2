plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
    alias(libs.plugins.hilt)
}

// :zakup — приложение закупщика (procurement). Отдельный APK, ставится на
// телефон кладовщика/закупщика. Тот же класс приложения, что и официант
// (телефон, PIN-вход, нижние табы), поэтому построен на тех же принципах, что
// :app, и переиспользует сеть/SSE/auth/конфиг из :core. Дизайн —
// design/app_zakup.pen (эмеральд-акцент, 16 экранов).
android {
    namespace = "com.restos.zakup"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.restos.zakup"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        // Backend URL — реальный host подменяется HostRedirectInterceptor из
        // ServerConfigStore (онбординг). Placeholder только для инициализации
        // Retrofit; до онбординга запросы не пойдут. v4 Go-бэк слушает на :3001.
        buildConfigField(
            "String",
            "API_BASE_URL",
            "\"http://10.0.2.2:3001/\"",
        )
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
        release {
            // LAN-приложение раздаётся сайдлоадом (по QR с кассы), не через Play.
            // Подписываем release debug-ключом — иначе assembleRelease даёт
            // неподписанный APK, который Android отказывается ставить.
            signingConfig = signingConfigs.getByName("debug")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    implementation(project(":core"))

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.activity.compose)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.extended)
    debugImplementation(libs.androidx.compose.ui.tooling)

    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.datastore.preferences)

    implementation(libs.hilt.android)
    ksp(libs.hilt.compiler)
    implementation(libs.hilt.navigation.compose)

    implementation(libs.retrofit.core)
    implementation(libs.retrofit.kotlinx.serialization)
    implementation(libs.okhttp.core)
    implementation(libs.okhttp.logging)
    implementation(libs.okhttp.sse)
    implementation(libs.kotlinx.serialization.json)

    // QR-онбординг (QrScannerView из :core): CameraX + ML Kit + разрешение камеры.
    implementation(libs.androidx.camera.core)
    implementation(libs.androidx.camera.camera2)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.view)
    implementation(libs.mlkit.barcode.scanning)
    implementation(libs.accompanist.permissions)

    testImplementation(libs.junit)
}
