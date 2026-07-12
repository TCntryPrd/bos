from fastapi import FastAPI
from fastapi.responses import Response
from pydantic import BaseModel
import subprocess
import tempfile
import os

app = FastAPI()


class SpeakRequest(BaseModel):
    text: str
    voice: str = "en-US-GuyNeural"


@app.post("/speak")
async def speak(req: SpeakRequest):
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
        tmp_path = tmp.name

    try:
        subprocess.run(
            ["edge-tts", "--voice", req.voice, "--text", req.text, "--write-media", tmp_path],
            check=True,
            capture_output=True,
            timeout=30,
        )
        with open(tmp_path, "rb") as f:
            audio_data = f.read()
        return Response(content=audio_data, media_type="audio/mpeg")
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)


@app.get("/voices")
async def voices():
    result = subprocess.run(
        ["edge-tts", "--list-voices"],
        capture_output=True,
        text=True,
        timeout=15,
    )
    voice_list = []
    for line in result.stdout.strip().split("\n"):
        if line.startswith("Name:"):
            voice_list.append(line.split("Name:")[1].strip())
    return {"voices": voice_list}


@app.get("/health")
def health():
    return {"status": "tts online"}
