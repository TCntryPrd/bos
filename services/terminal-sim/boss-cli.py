#!/usr/bin/env python3
"""
IR Custom AIOS Voice CLI — Terminal simulator for voice input/output.

Requirements: pip install sounddevice scipy psycopg requests
"""

import io
import os
import sys
import time
import tempfile
import requests
import psycopg
import sounddevice as sd
from scipy.io import wavfile

STT_URL = "http://127.0.0.1:8002/transcribe"
API_URL = "http://127.0.0.1:8001/spoken-command"
TTS_URL = "http://127.0.0.1:8003/speak"
POSTGRES_URL = "postgresql://boss:bosspass@127.0.0.1:5434/boss_db"

SAMPLE_RATE = 16000
RECORD_SECONDS = 5


def record_audio():
    print(f"  Recording for {RECORD_SECONDS} seconds...")
    audio = sd.rec(int(RECORD_SECONDS * SAMPLE_RATE), samplerate=SAMPLE_RATE, channels=1, dtype="int16")
    sd.wait()
    print("  Recording complete.")
    wav_path = "/tmp/boss-audio.wav"
    wavfile.write(wav_path, SAMPLE_RATE, audio)
    return wav_path


def transcribe(wav_path):
    with open(wav_path, "rb") as f:
        resp = requests.post(STT_URL, files={"file": ("audio.wav", f, "audio/wav")}, timeout=30)
    resp.raise_for_status()
    return resp.json().get("text", "").strip()


def send_command(text):
    resp = requests.post(
        API_URL,
        json={"text": text},
        headers={"Authorization": f"Bearer {os.getenv('BOSS_TOKEN', '')}"},
        timeout=60,
    )
    resp.raise_for_status()
    return resp.json()


def poll_for_result(text, timeout=30):
    """Poll boss_build_queue for a result matching the text."""
    start = time.time()
    with psycopg.connect(POSTGRES_URL) as conn:
        while time.time() - start < timeout:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, result, status FROM boss_build_queue WHERE request_text = %s ORDER BY id DESC LIMIT 1",
                    (text,),
                )
                row = cur.fetchone()
                if row and row[2] in ("DONE", "FAILED"):
                    return row[1]
            time.sleep(1)
    return None


def speak(text):
    try:
        resp = requests.post(TTS_URL, json={"text": text}, timeout=30)
        resp.raise_for_status()
        tmp = tempfile.NamedTemporaryFile(suffix=".mp3", delete=False)
        tmp.write(resp.content)
        tmp.close()
        # Try to play with available player
        for player in ["mpv --no-video", "ffplay -nodisp -autoexit", "aplay"]:
            cmd = player.split()[0]
            if os.system(f"which {cmd} > /dev/null 2>&1") == 0:
                os.system(f"{player} {tmp.name} > /dev/null 2>&1")
                break
        os.unlink(tmp.name)
    except Exception as e:
        print(f"  [TTS playback failed: {e}]")


def main():
    print("=" * 50)
    print("  BOSS Voice CLI")
    print("  Press Enter to record, Ctrl+C to quit")
    print("=" * 50)

    token = os.getenv("BOSS_TOKEN", "")
    if not token:
        print("  Warning: BOSS_TOKEN not set. Export it or set in env.")
        print("  e.g.: export BOSS_TOKEN=<your-boss-api-token>  # same value as BOSS_API_TOKEN in boss-dev/.env")
        print()

    while True:
        try:
            input("\n  Press Enter to speak...")

            # Record
            wav_path = record_audio()

            # Transcribe
            print("  Transcribing...")
            transcript = transcribe(wav_path)
            if not transcript:
                print("  [No speech detected]")
                continue
            print(f"  You said: {transcript}")

            # Send command
            print("  Sending to IR Custom AIOS...")
            result = send_command(transcript)
            intent = result.get("intent", "UNKNOWN")
            print(f"  Intent: {intent}")

            # Check if API returned a response directly
            response_text = result.get("response")

            if not response_text:
                # Poll for result
                print("  Waiting for response...")
                response_text = poll_for_result(transcript)

            if response_text:
                print(f"\n  IR Custom AIOS: {response_text}\n")
                speak(response_text)
            else:
                print("  [No response received within timeout]")

        except KeyboardInterrupt:
            print("\n  Goodbye.")
            sys.exit(0)
        except Exception as e:
            print(f"  Error: {e}")


if __name__ == "__main__":
    main()
