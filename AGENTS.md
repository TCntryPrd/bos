# Hermes Agent Docker Project Codex Operator

This is the live Hermes agent Docker project on Vasari-VPS.

## Scope

- Project root: `/docker/hermes-agent-qtbk`
- Codex/Gio workspace: `/docker/hermes-agent-qtbk/gio-workspace`
- Use `gio-workspace/MEMORY.md` and `gio-workspace/memory/` for durable Codex memory.
- Do not use or modify the older `vasari_*` Docker project unless Kevin explicitly asks.

## Live Hermes Weaviate

Use the live Vasari-BOS Weaviate attached to this Docker project:

- From the VPS host: `http://127.0.0.1:18082`
- From inside the `hermes-agent-qtbk` Docker network: `http://weaviate:8080`
- From local Codex over Tailscale/private network: `http://100.79.204.28:18082`
- Health check: `/v1/.well-known/ready`

Do not use the older separate `vasari_weaviate` at `http://127.0.0.1:8081` for live Vasari-BOS memory.

## Hooks

Codex cognitive-memory hooks live in both:

- `/docker/hermes-agent-qtbk/.codex/hooks.json`
- `/docker/hermes-agent-qtbk/gio-workspace/.codex/hooks.json`

The shared hook runner is `.codex/hooks/codex_memory.py`. It loads compact markdown memory at session start, searches markdown plus Weaviate for each prompt, and ingests compact session markers at stop/compact time.
