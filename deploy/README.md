# BOS — install or update one customer box

One BOS runs per customer VPS: its own domain, keys, PostgreSQL, embeddings,
Weaviate, cognitive-memory ledger, agent workspaces, Claude subscription, and
visual baseline. A customer BOS never queries Vasari's Weaviate and never uses
another customer's Claude credentials.

## Requirements

- Ubuntu 22.04+ VPS (8 GB recommended when local embeddings are enabled)
- Docker with the compose plugin, Python 3, and root access for the first install
- A domain/subdomain whose DNS A record points to the VPS

## Fresh install

```bash
tar xzf bos-release-<version>.tar.gz
cd bos-release
sudo DOMAIN=client.example.com OPERATOR_NAME="Jane Smith" ./deploy/install-bos.sh
```

Optional variables:

- `ACME_EMAIL`: Let's Encrypt contact
- `INSTALL_DIR`: install location, default `/docker/bos`
- `BOSS_AGENT_USER`: locked host runtime account, default `bosops`
- `BOSS_INSTALL_CLAUDE=0`: require a preinstalled Claude CLI instead of using
  Anthropic's native installer
- `BOSS_VISUAL_MANIFEST`: target-owned visual baseline, default
  `/var/lib/boss/visual-baseline.json`

The installer generates unique memory and application secrets, installs the
restricted host bridge, creates one permanent `boss-agent-<runtime-id>` tmux shell
for every enabled client manager/outsider, initializes the guarded local
`CodexMemory` class, runs a ledger reindex through the gateway, and captures the
customer's current backgrounds/avatar bindings as the approved visual baseline.

## Agent turn lifecycle

The runtime ID includes tenant, kind, handle, and a short tenant hash so two
tenants or agent kinds cannot collide. The tmux shell is permanent; the model
process is not. Each portal prompt starts
a fresh interactive Claude process in the correct shell with a new session ID,
loads `CLAUDE.md`, bounded cognitive-memory files, and guarded local semantic
recall, submits the prompt, streams the tmux pane, records the recap, then sends
`/exit` back to the idle shell. It does not use `claude -p` and does not resume a
growing Claude context. The portal interrupt action sends Escape to that active
interactive process.

The systemd timer `boss-agent-shells.timer` reconciles missing idle shells every
30 seconds. It does not restart or replace a shell that is already present.

## Claude subscription sign-in

Claude runs only in the host runtime account. The API receives a read-only mount
of that account's JSONL project logs for live streaming, not its auth files.
Complete sign-in once for the runtime account; do not copy operator or another
customer's credentials:

```bash
sudo -u bosops -H claude
```

Use the configured `BOSS_AGENT_USER` instead of `bosops` when customized.

## Guarded local memory

All retrieval and ingestion uses `/api/aios/memory` with the per-BOS
`AIOS_EDGE_INGEST_TOKEN`. The gateway redacts, embeds locally, deduplicates, and
records PostgreSQL ledger state before memory is considered durable. Weaviate is
API-key protected and bound to loopback on the host. Schema initialization is
authenticated; object reindexing still goes through the guarded gateway.
The installer and updater also verify that the existing Fastify server has the
gateway route registered before rebuilding the API, which keeps sparse customer
overlays from exposing a silent generic-auth fallback instead.

Recheck or repair the local path:

```bash
sudo bash ./deploy/init-local-memory.sh
```

This may create the `CodexMemory` class. It never inserts objects directly; its
reindex call goes through the guarded API.

## Updating an existing customer BOS

The visual baseline must be captured from the customer's current installation
before any release overlay. When introducing this guard to an older box, copy
only `scripts/visual-preserve.py` first, then run:

```bash
sudo python3 scripts/visual-preserve.py capture \
  --root "$PWD" --manifest /var/lib/boss/visual-baseline.json
```

Use the safe overlay to back up protected visuals, omit customer compose/env,
auth, and state files, apply functional release files without deletion, and
automatically restore visuals if verification detects drift:

```bash
sudo bash ./deploy/safe-overlay.sh /path/to/staged-release "$PWD"
```

Install or refresh the host runtime after the new release files are staged:

```bash
sudo BOSS_INSTALL_DIR="$PWD" bash ./deploy/install-agent-runtime.sh
```

Then run the customer-safe updater. It does not require a git worktree, does
not call `compose down`, and never removes volumes. It stops before replacing containers if any
recorded scene/avatar asset or visual binding changed. It also snapshots
`avatar_png` selections in `boss_rascals`, `boss_outsiders`, and
`boss_advisors`, verifies guarded semantic search/reindex, and checks every
enabled agent's tmux shell.

```bash
sudo bash ./deploy/update-bos.sh
```

`scripts/deploy.sh` is now a compatibility entry point for this same portable
updater. It deliberately refuses image-mode deployments whose customer service
names cannot be inferred safely.

Never update a customer with a sparse tree or a volume-deleting sync. Do not use
`rsync --delete` for BOS releases. Port functional changes into that target's
full tree and preserve its existing scene files, avatar picker/localStorage
bindings, and database avatar values.

If the owner explicitly approves a visual change, verify it on that target and
only then replace its baseline:

```bash
sudo python3 scripts/visual-preserve.py capture \
  --root "$PWD" --manifest /var/lib/boss/visual-baseline.json
```

## Verification

```bash
bash ./deploy/compose-runtime.sh ps
sudo -u bosops -H /usr/local/bin/boss-agent-shells status
bash ./deploy/compose-runtime.sh exec -T api ssh -o BatchMode=yes \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=/data/home/.ssh/boss-agent-runtime-known_hosts \
  -o GlobalKnownHostsFile=/dev/null -o UpdateHostKeys=no -o IdentitiesOnly=yes \
  -i /data/home/.ssh/boss-agent-runtime-bridge \
  bosops@host.docker.internal status
sudo bash ./deploy/init-local-memory.sh
```

Also verify from an external host that only 22/80/443 are reachable, test one
portal turn and interrupt, refresh the page to confirm the transient stream
clears, and confirm chat/TTS receive only the final recap.

## Invite and hardening

Run `./deploy/stage-invite.sh owner@email.com` to create the setup link. Key-only
SSH is intentionally left to the operator because an automated change can lock
out the box. Use the dead-man's-switch procedure from the VPS hardening playbook.

Factory reset must not delete `/var/lib/boss/visual-baseline.json`, the agent
workspace memory, Weaviate/PostgreSQL volumes, or another customer's auth. A
reset may clear only the intended customer's interactive onboarding state.
