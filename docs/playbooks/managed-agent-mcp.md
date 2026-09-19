# Managed Agent + MCP (the n8n replacement)

BOS reaches MCP servers through **Anthropic Managed Agents** instead of n8n.
Anthropic hosts the agent loop and a per-session container; BOS declares the
agent once and opens a session per task.

## Why this exists

The Settings → Global MCP tab called `/api/mcp/global*` endpoints that were
never implemented, and the API had no MCP client at all. n8n was the bridge.
This wires MCP into BOS directly, so n8n is no longer in the path.

## How the pieces fit

Managed Agents split MCP config across three objects — all three are required:

| Object | Holds | Created |
|---|---|---|
| **Agent** | `mcp_servers` (type/name/url, **no auth**) + an `mcp_toolset` per server | once, versioned on change |
| **Vault** | the `mcp_oauth` credential, keyed by MCP server URL | once |
| **Session** | `vault_ids` pointing at the vault | every run |

Credentials never enter the sandbox. Anthropic injects the token at egress and
refreshes it from the stored `refresh_token`, so the browser login is one-time.

## Setup

1. Set in `.env`:
   - `ANTHROPIC_API_KEY` — a real API key. A Claude CLI session is **not** enough.
   - `API_BASE_URL` — the public https origin. This is the OAuth redirect target
     (`<API_BASE_URL>/api/mcp/global/callback`); providers reject localhost.
   - `MYGENTIC_MCP_URL` — optional, seeds the connection on first boot.
2. Rebuild the API only (frontend is unchanged):
   `docker compose build api && docker compose up -d api`
3. Open **Settings → Global MCP**. Add the server if it wasn't seeded, then
   click **Login** and complete the provider's consent screen.
4. Confirm: the connection shows `authenticated`, or ask BOS to run
   `boss_mcp_list_connections`.

## Tools the COO gets

| Tool | Does |
|---|---|
| `boss_managed_agent_run` | Delegates a task to the agent with MCP attached. Replaces `boss_n8n_delegate`. |
| `boss_mcp_list_connections` | Lists MCP servers and whether each is logged in. |
| `boss_managed_agent_runs` | Recent runs with status, cost, and result text. |

Registered only when `ANTHROPIC_API_KEY` is set.

## Endpoints

```
GET    /api/mcp/global                        status + connections
POST   /api/mcp/global/connections            add a connection
DELETE /api/mcp/global/connections/:id        remove one
POST   /api/mcp/global/connections/:id/login  start PKCE → { authorizeUrl }
GET    /api/mcp/global/callback               OAuth redirect (unauthenticated)
POST   /api/mcp/agent/run                     run a task
GET    /api/mcp/agent/runs                    run history
```

The callback is the one unauthenticated route — a provider redirects a plain
browser to it, so it cannot carry a bearer token. The `state` parameter is
single-use and expires after 15 minutes.

## Login flow

The UI does **not** open the MCP URL directly; an OAuth-protected MCP endpoint
answers a browser with 401. Instead the API runs the flow server-side:

1. Discover — RFC 9728 `/.well-known/oauth-protected-resource`, then RFC 8414
   `/.well-known/oauth-authorization-server`. Falls back to `/authorize` +
   `/token` on the server's origin when nothing is published.
2. Register — RFC 7591 dynamic client registration, so no client_id by hand.
3. PKCE — S256 challenge; the verifier is stored against a single-use `state`.
4. Return `authorizeUrl`; the browser opens it.
5. On callback, exchange the code and push the tokens into the Anthropic vault.

## Troubleshooting

- **"not logged in" after a successful consent screen** — `API_BASE_URL` was
  wrong when the flow started, so the redirect never came back. Fix it and
  click Login again.
- **"did not support dynamic client registration"** — register BOS manually
  with the provider using the redirect URI above, then store the `client_id`.
- **Session runs but MCP calls fail auth** — an invalid vault credential does
  not block session creation; look for a `session.error` event. Re-run Login to
  mint a fresh credential (the old one is archived automatically).
- **Tables missing** — the API creates them on demand, and
  `deploy/schema-idempotent.sql` carries them for reconcile. Re-run
  `docker compose up migrate`.
