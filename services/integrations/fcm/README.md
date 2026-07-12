# FCM Push Notifications Integration

Firebase Cloud Messaging server-side integration for IR Custom AIOS.

## Overview

This integration allows IR Custom AIOS to send push notifications to mobile devices, particularly for P1 alerts and important notifications that require immediate attention.

## Components

1. **Python Module** (`../../api/app/push_notify.py`): Contains the core FCM functionality
2. **API Endpoint** (`POST /notify`): Exposes notification sending capability via HTTP
3. **Integration**: Wired into the monitor system for automatic P1 alert notifications

## Setup Requirements

### 1. Firebase Project Setup
- Create a Firebase project at https://console.firebase.google.com/
- Navigate to Project Settings > Cloud Messaging
- Copy the "Server key" from the Cloud Messaging tab

### 2. Device Token Acquisition
- For testing: Use Firebase Console > Cloud Messaging to send test messages
- For production: Implement Firebase SDK in the mobile app to retrieve device tokens

### 3. Environment Configuration
Add the following to your `.env.boss-token` file:

```bash
FCM_SERVER_KEY=your_firebase_server_key_here
FCM_DEVICE_TOKEN=your_device_token_here
```

## Usage

### Direct Function Usage
```python
from app.push_notify import send_push

result = send_push(
    title="Important Alert", 
    body="This is an urgent notification",
    device_token="optional_specific_device_token"  # Uses default if omitted
)
```

### API Endpoint Usage
```bash
curl -X POST http://127.0.0.1:8001/notify \
  -H "Authorization: Bearer <REDACTED: BOSS_API_TOKEN — see .env.boss-token>" \
  -H "Content-Type: application/json" \
  -d '{"title": "Alert", "body": "Something important happened"}'
```

## Integration with Monitor System

The FCM integration is wired into the monitor system to automatically send P1 alerts to your phone. When critical system events occur, notifications will be pushed automatically.

## Troubleshooting

### Common Issues
1. **Invalid Server Key**: Ensure the FCM_SERVER_KEY is correctly copied from Firebase Console
2. **Invalid Device Token**: Verify the device token format and validity
3. **Network Issues**: Ensure the server can reach FCM endpoints (requires internet access)

### Testing
- Use Firebase Console to verify your server key works independently
- Check application logs for detailed error messages
- Validate that `.env.boss-token` is properly loaded by the API service