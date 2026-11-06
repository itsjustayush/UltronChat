# UltronChat Mobile — Cross-Platform Shell (Android & iOS)

This directory contains the lightweight Flutter mobile native shell for **UltronChat**. It embeds the complete web application using hardware-accelerated WebRTC DataChannels, safe-area insets, and native camera QR scanning permissions.

---

## 🚀 Key Mobile Features

1. **Exact UI Parity**: Uses the identical dark cyberpunk liquid design from the web client without duplicating widget code.
2. **WebRTC Camera & Audio Permissions**: Configured in `AndroidManifest.xml` and `Info.plist` to grant WebRTC audio/video and QR code scanner permissions.
3. **Android Foreground Keep-Awake**: Screen Wake Lock support to prevent transfer interruption when moving large files.
4. **Offline & Retry Handling**: Detects connection interruptions and offers 1-tap reconnect.

---

## 🛠 Prerequisites

* Flutter SDK (3.0.0 or higher)
* Android Studio (for Android builds) / Xcode (for iOS builds on macOS)

---

## 📱 Running the Mobile App

### 1. Install Dependencies
```bash
cd mobile
flutter pub get
```

### 2. Run on Android Emulator or Connected Device
```bash
flutter run
```

### 3. Build Production APK / Android App Bundle (AAB)
```bash
# Build standalone release APK
flutter build apk --release

# Build Google Play App Bundle
flutter build appbundle --release
```

### 4. Build for iOS (on macOS)
```bash
flutter build ipa --release
```

---

## ⚙️ Configuration

To point the mobile app to a custom URL or staging environment, edit `defaultAppUrl` in `lib/main.dart`:

```dart
static const String defaultAppUrl = 'https://your-custom-domain.vercel.app';
```

