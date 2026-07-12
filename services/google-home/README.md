# Google Home Integration Setup

## Step 1: Google Home Developer Console
1. Go to https://console.home.google.com
2. Sign in with your Google account
3. Create a new project: "IR Custom AIOS"
4. Under "Setup & configuration" → enable Smart Home API
5. Add OAuth client ID (Web application type)
6. Authorized redirect URI: https://last-castle.daggertooth-larch.ts.net/boss/google-home/oauth/callback
7. Download credentials JSON → save as boss-dev/services/google-home/credentials.json

## Step 2: Complete OAuth Flow
1. Start the service: `docker compose up -d google-home`
2. Visit: https://last-castle.daggertooth-larch.ts.net/boss/google-home/oauth/start
3. Sign in with your Google account and authorize
4. Tokens will be saved automatically to tokens.json

## Step 3: Local Device Discovery (Works Without OAuth)
Even without OAuth setup, the service can discover and control Chromecast/Google TV devices
on the local network using the pychromecast library.

- GET /devices — discovers devices via local network scan
- POST /control — controls devices (play, pause, volume)

## Step 4: Google Home App Linking (for production)
For personal/dev use, use the Google Home SDK local fulfillment path.
Enable Local Home SDK in the project for LAN-based control.

## API Endpoints
- GET /status — shows configuration status
- GET /devices — lists discovered Google Home / Chromecast devices
- POST /control — `{"device": "Living Room TV", "action": "pause"}`
- GET /oauth/start — begins OAuth flow
- GET /oauth/callback — OAuth2 callback handler
- GET /health — health check
