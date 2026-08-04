plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
    alias(libs.plugins.hilt)
}

// :kiosk — терминал самозаказа (планшет/тотем в зале, тач-экран,
// покупатель делает заказ сам, как в McDonald's/KFC/Drinkit). Один раз
// активируется PIN-ом сотрудника (роль "kiosk", см. server perms.go), после
// чего работает автономно: Выбор формата → Меню → Заказ создан → сброс на
// старт для следующего гостя. Построен на тех же принципах, что и :zakup,
// переиспользует сеть/SSE/auth/конфиг из :core. Дизайн — стиль Drinkit
// (индиго-акцент #4F46E5, крупные плитки/карточки, пилюли).
android {
    namespace = "com.restos.kiosk"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.restos.kiosk"
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

    // LAN-приложение раздаётся сайдлоадом (не через Play) — lintVitalRelease не
    // нужен и сильно замедляет release-сборку. Lint остаётся доступным вручную
    // (./gradlew :kiosk:lint), но не блокирует assembleRelease.
    lint {
        checkReleaseBuilds = false
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
