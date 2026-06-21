# Building n8n Workflows

## API Rules
- **Create**: `POST /api/v1/workflows` with `{name, nodes, connections, settings}`
- **Update**: `PUT /api/v1/workflows/{id}` — PUT only, PATCH not allowed
- **Activate**: `POST /api/v1/workflows/{id}/activate`
- **Deactivate**: `POST /api/v1/workflows/{id}/deactivate`
- **`active` is READ-ONLY** — never include it in PUT/POST body

## Credentials
Credentials must be embedded in the node definition at creation time. Use these EXACT IDs:

| Service | Credential Type | ID | Name |
|---------|----------------|-----|------|
| Gmail | gmailOAuth2 | DJ2FnS1NT6Sv2YZI | DCS Gmail |
| Telegram | telegramApi | aZCwMJQTTDzrBju7 | IR Custom AIOS - Telegram account |
| Slack | slackApi | 3yHwTvrqtn1AMO8K | Slack account |
| Calendar | googleCalendarOAuth2Api | f05a5mhGQOJJBybo | DCS Calendar |
| Drive | googleDriveOAuth2Api | gp94gRo6fRC7TPDL | DCS Drive |
| Sheets | googleSheetsOAuth2Api | 1KPe8rg6gmSwg1gP | DCS Sheets |
| Docs | googleDocsOAuth2Api | ikSBTCFXNGWMSKTw | DCS Docs |
| Tasks | googleTasksOAuth2Api | ng5MLEAluHVG6I2F | DCS Tasks |
| Contacts | googleContactsOAuth2Api | 8grTKGlGvlGrn3IA | DCS Contacts |

Format in node: `"credentials": { "gmailOAuth2": { "id": "DJ2FnS1NT6Sv2YZI", "name": "DCS Gmail" } }`

If credentials are not baked in at creation, n8n treats them as "shared" and blocks auto-selection in the UI.

## Node Format
```json
{
  "type": "n8n-nodes-base.gmail",
  "name": "Get Messages",
  "parameters": { "operation": "getAll", "returnAll": false, "limit": 10 },
  "position": [250, 300],
  "credentials": { "gmailOAuth2": { "id": "DJ2FnS1NT6Sv2YZI", "name": "DCS Gmail" } }
}
```

## Common Mistakes
- Webhook nodes MUST include `webhookId` or they 404
- Code nodes block `fs` module — use `Buffer.from()` for binary
- Never include `active` in the workflow body
- Google Drive node v3 has bugs — use v2
