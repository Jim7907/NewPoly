# SafeCam

A **transparent** background security/dashcam recorder for Android. Built for
recording **your own spaces** — your home, your car, your property — for safety
and security.

> **This is not a covert/spy app and is not designed to be one.**
> While recording, SafeCam shows a permanent notification, and Android 12+
> shows its own green camera/mic indicator. The app icon is visible in the
> launcher. There is intentionally no way to hide that recording is happening.
> Recording people without consent may be illegal where you live — check your
> local laws (especially for audio).

## Features

- **Background recording** via a CameraX foreground service — keeps recording
  when you switch apps or turn the screen off.
- **Night mode** — boosts exposure for low-light scenes, with an optional
  torch.
- **Audio on/off**, **front/back camera**, and **auto-start after reboot**
  (opt-in).
- **Segmented files** — footage is chunked (default 10 min) into
  `Movies/SafeCam/` via MediaStore, so a crash never loses everything.

## Requirements

- Android Studio (Koala or newer) / Android Gradle Plugin 8.5+
- minSdk 26, targetSdk 34

## Build

Open the `SafeCam/` folder in Android Studio and let it sync, **or** from the
command line generate the Gradle wrapper once and build:

```bash
cd SafeCam
gradle wrapper --gradle-version 8.9   # creates gradlew + wrapper jar
./gradlew assembleDebug
```

The APK lands in `app/build/outputs/apk/debug/`.

## How it works

| Piece | File |
|---|---|
| UI + permission requests + setting toggles | `MainActivity.kt` |
| Foreground service, CameraX VideoCapture, night tuning, segment rollover | `RecordingService.kt` |
| Persisted preferences | `SettingsStore.kt` |
| Optional restart after reboot | `BootReceiver.kt` |

### Night recording

For video, SafeCam maxes out the camera's exposure-compensation index and
(optionally) turns on the torch. Image-capture `NIGHT` extensions are not used
because they generally don't apply to the `VideoCapture` use case.

## Permissions

- `CAMERA`, `RECORD_AUDIO` — capture.
- `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_CAMERA`,
  `FOREGROUND_SERVICE_MICROPHONE` — background recording (Android 14+ requires
  typed foreground services).
- `POST_NOTIFICATIONS` — the required ongoing notification (Android 13+).
- `RECEIVE_BOOT_COMPLETED` — only used if you enable auto-start.

## Legal & ethical use

Use SafeCam only where you have the right to record. One-party vs. all-party
consent for audio varies by jurisdiction. Recording others covertly may be a
crime. This project deliberately avoids hidden-recording features.
