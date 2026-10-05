plugins {
    id("com.android.application")
}

// The web UI is shared with the desktop app: copy flashcard_viewer/ui into the APK's assets.
val webAssetsDir: File = layout.buildDirectory.dir("generated/webassets").get().asFile
val copyWebAssets by tasks.registering(Sync::class) {
    from(rootProject.file("../flashcard_viewer/ui"))
    into(File(webAssetsDir, "ui"))
}

android {
    namespace = "io.github.naved124.flashcardviewer"
    compileSdk = 34

    defaultConfig {
        applicationId = "io.github.naved124.flashcardviewer"
        minSdk = 26          // Android 8.0
        targetSdk = 34
        versionCode = 4
        versionName = "1.1.2"
    }

    signingConfigs {
        // Use your own key when ANDROID_KEYSTORE_FILE etc. are set (see README); otherwise the
        // repository's public sideload key, so every build can update the previous one.
        create("release") {
            val ks = System.getenv("ANDROID_KEYSTORE_FILE")
            if (!ks.isNullOrBlank() && file(ks).exists()) {
                storeFile = file(ks)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            } else {
                storeFile = file("sideload.keystore")
                storePassword = "flashcardviewer"
                keyAlias = "sideload"
                keyPassword = "flashcardviewer"
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    sourceSets {
        getByName("main") {
            assets.srcDir(webAssetsDir)
        }
    }
}

tasks.named("preBuild") { dependsOn(copyWebAssets) }
