# IR Custom AIOS v2 — STT Service Dockerfile (faster-whisper / FastAPI)
# Multi-stage: builder installs deps, runner is lean production image.
#
# Model weights are NOT baked into the image — they download to a mounted
# volume on first start (stt_models -> /root/.cache/huggingface).
# Subsequent starts are instant since the cache is warm.

# ---- Stage 1: build / dependency install ----
FROM python:3.11-slim AS builder

WORKDIR /build

# ffmpeg is required by faster-whisper for audio decoding
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    build-essential \
  && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# ---- Stage 2: production runner ----
FROM python:3.11-slim AS runner

# Runtime needs: ffmpeg for audio decode, no build tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy installed Python packages from builder
COPY --from=builder /install /usr/local

# Copy application code
COPY app ./app

# Expose model cache dir as a mountable volume
VOLUME /root/.cache/huggingface

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
