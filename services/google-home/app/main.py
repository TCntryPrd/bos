from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel
import os
import json

app = FastAPI()

CREDENTIALS_PATH = os.getenv("CREDENTIALS_PATH", "/app/credentials.json")
TOKENS_PATH = os.getenv("TOKENS_PATH", "/app/tokens.json")


def credentials_exist():
    return os.path.exists(CREDENTIALS_PATH)


def tokens_exist():
    return os.path.exists(TOKENS_PATH)


class ControlRequest(BaseModel):
    device: str
    action: str


@app.get("/health")
def health():
    return {"status": "google-home online"}


@app.get("/status")
def status():
    configured = credentials_exist() and tokens_exist()
    return {
        "configured": configured,
        "credentials_present": credentials_exist(),
        "tokens_present": tokens_exist(),
        "message": "Place credentials.json from Google Home Developer Console to configure"
        if not credentials_exist()
        else "Ready" if configured else "OAuth flow needed — visit /oauth/start",
    }


@app.get("/devices")
def list_devices():
    if not credentials_exist():
        return JSONResponse(
            status_code=503,
            content={"error": "credentials.json not found. See README.md for setup."},
        )

    # Try pychromecast for local device discovery
    try:
        import pychromecast

        services, browser = pychromecast.discovery.discover_chromecasts(timeout=5)
        browser.stop_discovery()
        devices = [
            {
                "name": s.friendly_name,
                "host": s.host,
                "port": s.port,
                "model": s.model_name,
                "type": "chromecast",
            }
            for s in services
        ]
        return {"devices": devices, "source": "local_discovery"}
    except Exception as e:
        return {"devices": [], "source": "local_discovery", "error": str(e)}


@app.post("/control")
def control(req: ControlRequest):
    device_name = req.device.lower()
    action = req.action.lower()

    # Try Google Home API if tokens exist
    if tokens_exist():
        try:
            return _control_via_api(device_name, action)
        except Exception as e:
            pass

    # Fallback to Chromecast SDK
    try:
        return _control_via_chromecast(device_name, action)
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"error": f"Control failed: {e}", "device": req.device, "action": req.action},
        )


def _control_via_chromecast(device_name: str, action: str):
    import pychromecast

    services, browser = pychromecast.discovery.discover_chromecasts(timeout=5)
    chromecasts, browser = pychromecast.get_listed_chromecasts(
        friendly_names=[device_name]
    )
    browser.stop_discovery()

    if not chromecasts:
        return JSONResponse(
            status_code=404,
            content={"error": f"Device '{device_name}' not found on network"},
        )

    cast = chromecasts[0]
    cast.wait()

    if action in ("pause", "stop"):
        cast.media_controller.pause()
    elif action == "play":
        cast.media_controller.play()
    elif action.startswith("volume"):
        # e.g. "volume 50" -> set to 0.5
        parts = action.split()
        if len(parts) > 1:
            level = int(parts[1]) / 100.0
            cast.set_volume(level)

    return {"status": "ok", "device": device_name, "action": action, "via": "chromecast"}


def _control_via_api(device_name: str, action: str):
    # Placeholder for Google Home API control via HomeGraph
    # Requires OAuth tokens from the setup flow
    return JSONResponse(
        status_code=501,
        content={"error": "Google Home API control not yet implemented. Use Chromecast fallback."},
    )


@app.get("/oauth/start")
def oauth_start():
    if not credentials_exist():
        return JSONResponse(
            status_code=503,
            content={"error": "credentials.json not found. See README.md for setup."},
        )

    try:
        from google_auth_oauthlib.flow import Flow

        flow = Flow.from_client_secrets_file(
            CREDENTIALS_PATH,
            scopes=["https://www.googleapis.com/auth/homegraph"],
            redirect_uri="https://last-castle.daggertooth-larch.ts.net/boss/google-home/oauth/callback",
        )
        auth_url, _ = flow.authorization_url(prompt="consent")
        return RedirectResponse(auth_url)
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.get("/oauth/callback")
def oauth_callback(request: Request):
    code = request.query_params.get("code")
    if not code:
        return JSONResponse(status_code=400, content={"error": "No authorization code"})

    try:
        from google_auth_oauthlib.flow import Flow

        flow = Flow.from_client_secrets_file(
            CREDENTIALS_PATH,
            scopes=["https://www.googleapis.com/auth/homegraph"],
            redirect_uri="https://last-castle.daggertooth-larch.ts.net/boss/google-home/oauth/callback",
        )
        flow.fetch_token(code=code)
        creds = flow.credentials

        token_data = {
            "token": creds.token,
            "refresh_token": creds.refresh_token,
            "token_uri": creds.token_uri,
            "client_id": creds.client_id,
            "client_secret": creds.client_secret,
        }
        with open(TOKENS_PATH, "w") as f:
            json.dump(token_data, f)

        return {"status": "OAuth complete", "tokens_saved": True}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})
