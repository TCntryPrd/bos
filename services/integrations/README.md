# IR Custom AIOS Integrations

This directory contains platform integrations for the IR Custom AIOS system.

## Available Integrations

### 1. Galaxy Watch 8 / Wear OS Tile
- **Location:** `wear-os/`
- **Description:** Kotlin Jetpack Compose Wear OS tile app that provides quick access to IR Custom AIOS
- **Features:**
  - Shows last IR Custom AIOS response (cached)
  - 3 quick action buttons: "Brief Me", "Check Email", "Project Status"
  - Taps send commands via companion Android app to IR Custom AIOS API
- **Setup:** Requires sideloading to Wear OS device
- **Status:** Ready to build and deploy

### 2. Smart TV Web UI
- **Location:** `tv/`
- **Description:** Single HTML file interface optimized for TV browsers
- **Features:**
  - Large readable text (min 24px)
  - High contrast dark theme
  - Keyboard/remote navigable (arrow keys, enter to select)
  - Sections: Daily Briefing, Email Summary, Project Status, Voice Command input
  - Fetches from IR Custom AIOS API on load
  - Route: GET /tv serves the interface
- **Status:** Ready to use (accessible at `/tv` endpoint)
- **Compatibility:** Works in Samsung Tizen browser and modern TV browsers

### 3. Android Quick Tile
- **Location:** `android/`
- **Description:** Android TileService appearing in Quick Settings panel
- **Features:**
  - Tile label: "IR Custom AIOS"
  - Tap opens voice input activity that records mic
  - Sends to POST /spoken-command
  - Plays TTS response via MediaPlayer
  - TTS audio from ElevenLabs (fallback to edge-tts)
- **Status:** Ready to build and install
- **Permissions:** Requires RECORD_AUDIO permission

### 4. FCM Push Notifications
- **Location:** `fcm/` (server-side logic in `../api/app/push_notify.py`)
- **Description:** Firebase Cloud Messaging integration for push notifications
- **Features:**
  - Python module: `push_notify.py` with `send_push(title, body, device_token)` function
  - POST /notify endpoint accepting {title, body} and sending to Kevin's device
  - FCM_SERVER_KEY and FCM_DEVICE_TOKEN in .env.boss-token
  - Integrated with monitor.py to send P1 alerts to phone
- **Status:** Ready to configure with FCM credentials
- **Configuration:** Requires FCM server key and device token

## Environment Configuration

The FCM integration requires the following in `.env.boss-token`:

```bash
FCM_SERVER_KEY=your_firebase_server_key_here
FCM_DEVICE_TOKEN=your_device_token_here
```

## Test Commands

### Wear OS / Android Integration Tests
```bash
# Test voice command endpoint (used by Android tile)
curl -X POST http://127.0.0.1:8001/spoken-command \
  -H "Authorization: Bearer <REDACTED: BOSS_API_TOKEN — see .env.boss-token>" \
  -H "Content-Type: application/json" \
  -d '{"text": "Brief me on my day"}'
```

### Smart TV UI Test
```bash
# Access the TV UI
open http://127.0.0.1:8001/tv
```

### FCM Push Notification Test
```bash
# Send a test push notification
curl -X POST http://127.0.0.1:8001/notify \
  -H "Authorization: Bearer <REDACTED: BOSS_API_TOKEN — see .env.boss-token>" \
  -H "Content-Type: application/json" \
  -d '{"title": "Test Notification", "body": "This is a test from IR Custom AIOS"}'
```

## Build Instructions

### Wear OS Tile
```bash
cd wear-os/
./gradlew assembleDebug
# Then sideload to Wear OS device
adb install app/build/outputs/apk/debug/app-debug.apk
```

### Android Quick Tile
```bash
cd android/
./gradlew assembleDebug
# Then install to Android device
adb install app/build/outputs/apk/debug/app-debug.apk
```

### Smart TV UI
No build step needed - served directly from the API server at `/tv` endpoint.

## FCM Setup Instructions

1. Create a Firebase project at https://console.firebase.google.com/
2. Enable Firebase Cloud Messaging for the project
3. Obtain your Server Key from Project Settings > Cloud Messaging
4. Get your device token from the Firebase console or via the Firebase SDK
5. Add both values to `.env.boss-token` as shown above
6. Restart the IR Custom AIOS API service