# Image Generation & UI Integration

## Generating Images with Gemini
- Model: `gemini-2.5-flash-image` (the old `gemini-2.0-flash-exp-image-generation` is retired)
- Use `boss_image_generate` tool or direct API via `boss_bash`
- Response includes base64 image data — must decode and save to disk
- VERIFY the file exists after saving. `ls -la /path/to/file` — if it's not there, it didn't work.

## Adding Images to the IR Custom AIOS Web UI
1. Save the image to `apps/web/src/assets/` (NOT public/, NOT root)
2. In the React component, reference with: `new URL('../assets/filename.png', import.meta.url).href`
3. DO NOT use absolute paths like `/filename.png` — they break under Tailscale path prefixes
4. Rebuild: `docker compose build web && docker compose up -d web`
5. Verify inside container: `docker exec boss_web ls /usr/share/nginx/html/assets/ | grep filename`

## Why Absolute Paths Break
The web UI is served under `/boss/ui/` via Tailscale. The browser resolves `/` to the Tailscale root (n8n at port 5678), not the web container. Vite's `import.meta.url` pattern bundles the image with a content hash into `./assets/` which resolves correctly.

## Uploading to Google Drive
- Decrypt the access token from `boss_oauth_tokens` using `BOSS_TOKEN_ENCRYPTION_KEY`
- Upload via `POST https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`
- Set permissions for sharing: `POST /drive/v3/files/{id}/permissions` with `{"role":"reader","type":"anyone"}`
