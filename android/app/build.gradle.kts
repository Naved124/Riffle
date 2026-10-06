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
        versionCode = 12
        versionName = "1.0.3"
    }

    // Release builds are signed with your private key, passed in by CI from repository secrets
    // (see tools/make-release-keys.sh). Without it, build the debug variant instead.
    val keystore = System.getenv("ANDROID_KEYSTORE_FILE")
    val haveKey = !keystore.isNullOrBlank() && file(keystore).exists()
    signingConfigs {
        if (haveKey) {
            create("release") {
                storeFile = file(keystore!!)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (haveKey) signingConfig = signingConfigs.getByName("release")
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
