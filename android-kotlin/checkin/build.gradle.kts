plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
    alias(libs.plugins.hilt)
}

// :checkin — терминал учёта рабочего времени (планшет у служебного входа).
// Сотрудник отмечает приход/уход своим 4-значным PIN, дальше отметки попадают
// в табель (time_entries) и в расчёт дневной ЗП. Устройство активируется
// ОДИН раз PIN-ом (как :kiosk), после чего живёт автономно и общее для всей
// смены — это не персональное приложение сотрудника, поэтому отметка не
// создаёт сессию и не меняет токен устройства.
//
// Сеть/SSE/auth/онбординг переиспользуются из :core.
android {
    namespace = "com.restos.checkin"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.restos.checkin"
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
    // (./gradlew :checkin:lint), но не блокирует assembleRelease.
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

    // CameraX + ML Kit: сейчас — QR-онбординг (QrScannerView из :core),
    // дальше — селфи-фиксация при отметке прихода (фронтальная камера).
    implementation(libs.androidx.camera.core)
    implementation(libs.androidx.camera.camera2)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.view)
    implementation(libs.mlkit.barcode.scanning)
    // Детекция лица при отметке: снимок без человека в кадре бессмыслен как
    // доказательство — им можно «отметить» кого угодно, закрыв камеру.
    implementation(libs.mlkit.face.detection)
    implementation(libs.accompanist.permissions)

    testImplementation(libs.junit)
}
