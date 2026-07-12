# IR Custom AIOS Forward Plan — From Today to Sovereign

**Date:** 2026-04-29
**Companion to:** `2026-04-29-state-of-boss-audit.md`
**Status:** Draft for Kevin's review
**Author:** Claude (main session) — synthesized from audit + Kevin's stated vision
**Supersedes:** parts of `BOSS_MASTER_PLAN.md` (see §5)

---

## Why this plan exists

The v2 Master Plan (2026-04-23) treats IR Custom AIOS as a *containerized application*. The vision Kevin articulated 2026-04-29 treats IR Custom AIOS as a *sovereign agent who owns the box*. The audit (`2026-04-29-state-of-boss-audit.md`) shows two things at once:

1. **Sovereignty is 70% there.** 130 brain tools, 7 self-mod tools, trust-tier gating, bypass-on COO surface, working CI ceremony, host-native services. The substrate exists.
2. **Durability is in active crisis.** 6 nights of backups have failed silently. 17 n8n workflows have zero off-host capture. Memory files unbacked. **Right now, a single volume loss is a partial-recovery scenario, not a no-loss scenario.**

This plan does three things, in order of urgency:

1. **Stop the durability bleed** (this week)
2. **Close the sovereignty gap** (next 4–6 weeks, parallel stream)
3. **Reconcile the Master Plan** — kill what's dead, defer what's stalled, keep what serves Kevin

---

## 1. The two streams

```
                         TODAY
                           │
            ┌──────────────┼──────────────┐
            ▼              ▼              ▼
       D-stream       S-stream      Feature work
       Durability     Sovereignty   (v1.7.13+, off-plan)
            │              │              │
            ▼              ▼              ▼
         vD.0.1         vS.0.1         v1.7.13
         vD.0.2         vS.0.2         v1.7.14
         vD.0.3         vS.0.3         ...
            │              │              │
            └──────────────┼──────────────┘
                           ▼
                       SOVEREIGN BOSS
                  (v2.0.0 — true substrate)
```

Each stream has its own version namespace (`vD.x.y` for durability, `vS.x.y` for sovereignty) so they don't collide with feature ships (`v1.x.y`). Each stream ships independently. Ceremony is the same: PR → tag → CI → smoke → memory.

---

## 2. Durability stream (vD) — START THIS WEEK

The audit found three live durability fires. These get fixed first, full stop.

### vD.0.1 — Stop the backup-push bleed (URGENT, ~1 day)

**Problem:** Backup script chains git history; one >100MB file (Weaviate snapshot 173MB on 2026-04-23) blocks every subsequent push to `github.com/TCntryPrd/boss-backups`. **6 consecutive nights have failed silently.** All snapshots are in `/tmp/boss-backups/` — local-only, possibly tmpfs-ephemeral.

**Ship target:**

1. **Off-host artifact path.** Switch the daily backup destination away from a single git repo. Three viable options:
   - **B3 (recommended):** Backblaze B2 bucket via `rclone` (cheap, simple, encrypted, no file size limit). ~$0.005/GB/month.
   - S3 (pricier, more familiar)
   - Self-hosted MinIO on a separate cheap VPS
   
2. **Move existing 9-day local snapshot set off-host immediately** (one-time).

3. **Rebuild the broken `boss-backups` git repo:** drop the 173MB blob via `git filter-repo`, force-push (with explicit Kevin auth), or just abandon it and treat B2 as the canonical backup target.

4. **Add health check:** `boss_backup_status` brain tool. Returns last-successful-snapshot timestamp per asset. Wire into a deploy-smoke that fails CI if any asset is >36h since last successful upload.

5. **Move `/tmp/boss-backups/` to `/var/lib/boss-backups/` or similar persistent path** (verify `/tmp` policy first).

**Smoke #46:** assert backup script runs end-to-end and uploads a fresh artifact to B2 within last 25h.

**Tools added:** `boss_backup_status` (observer), `boss_backup_run_now` (admin).

### vD.0.2 — n8n workflow capture (~1 day)

**Problem:** 17 n8n workflows live only in `n8n_postgres_data` volume. No script exports them. Volume loss = total loss. Kevin's stated fear, verified.

**Ship target:**

1. **Cron job** at e.g. `30 4 * * *` (after main backup): call n8n's REST API `/api/v1/workflows` → dump each workflow as JSON to `~/n8n-backups/workflows/<id>-<name>-YYYYMMDD.json`.

2. **Git-mirror those JSONs** to `github.com/TCntryPrd/n8n-workflow-archive` (new private repo, hourly auto-commit).

3. **Idempotent restore script** `scripts/n8n-restore.sh` that reads the JSONs and POSTs them back to n8n via the API. Documented in the script.

4. **Brain tool:** `boss_n8n_export_all` (operator) that triggers the dump on demand.

5. **Smoke #47:** asserts at least 17 `*.json` files exist in the archive repo and the newest is <25h old.

### vD.0.3 — Memory file backup (~half day)

**Problem:** 41 body files in `~/.claude/projects/.../memory/` plus MEMORY.md. Not in any backup. A `rm -rf ~/.claude` destroys institutional memory.

**Ship target:**

1. **Add `~/.claude/projects/-home-tcntryprd--claude/memory/` and `~/.claude/CLAUDE.md` to `auto-commit-all.sh`** REPOS array — push to a new private repo `github.com/TCntryPrd/cc-memory`.

2. **Verify push works** (memory is small; no 100MB risk).

3. Skill files at `~/.claude/skills` are already covered (sp-hub git-tracked).

4. `~/.openclaw/openclaw.json` and `~/.claude/settings.json` — same pattern, separate repo `cc-config`.

**Effort:** trivial. Ride along with vD.0.2.

### vD.1.0 — Container volume snapshots (~2 days)

**Problem:** Postgres + Weaviate + Redis volumes are local-only. Backup script dumps Postgres SQL but not the volume itself. A volume corruption is a partial-recovery scenario.

**Ship target:**

1. **Daily volume-level snapshot** of each IR Custom AIOS + n8n stateful volume to B2: `tar.gz` the volume's directory inside the container's mount, ship it.
2. **Weekly retention rotation:** keep daily for 7 days, weekly for 4 weeks, monthly for 6 months.
3. **Restore-rehearsal script:** `scripts/disaster-rehearsal.sh` — spins up a parallel test container set, restores from B2, verifies row counts. Run monthly.
4. **Smoke #48:** asserts restore-rehearsal ran within last 35 days.

### vD.1.1 — Backup observability dashboard (~1 day)

**Problem:** Six failed nights happened silently. There must be a place Kevin can glance and see "all backups green."

**Ship target:**

1. **`/coe` (or new `/vault`) panel:** small status grid showing each backup asset + last success + size + bytes-uploaded. Reads from `boss_backup_status`.
2. **Slack/Telegram nightly summary** ping at 04:30 UTC after the backup run. One-line green or red.

---

## 3. Sovereignty stream (vS) — START NEXT WEEK

Sequenced from least-risky to most-risky. Each ship adds capability AND removes Kevin from a bottleneck.

### vS.0.1 — "What's the state of the server?" (~1 day)

**Goal:** IR Custom AIOS can answer the canonical state question from a single brain-tool call.

**What's there:** `boss_sys_info`, `boss_sys_docker`, `boss_sys_services`, `boss_sys_updates` exist and work.

**What's missing:**
- **Compose tool** `boss_host_status` — returns one structured object with: OS, kernel, uptime, disk, mem, all containers (status + image tag + uptime), all systemd user services, apt updates pending, firewall posture, last successful backup per asset (uses vD.0.1's `boss_backup_status`), n8n workflow count + activation state, last 5 CI runs, last 5 commits per active repo.
- Auto-invoked by IR Custom AIOSOrb when Kevin says "IR Custom AIOS, status" or "state of the server".

**Smoke #49:** asserts `boss_host_status` returns valid JSON with all required keys.

**No new trust tier needed** — observer.

### vS.0.2 — CI/PR introspection (~1.5 days)

**Goal:** IR Custom AIOS can see her own GitHub Actions runs and PR comments, react to them.

**What's missing in `tools/github.ts`:**
- `boss_github_workflow_runs` — list runs with status/conclusion (observer)
- `boss_github_workflow_run_logs` — fetch logs for a failed run (observer)
- `boss_github_pr_comments` — list PR review comments (observer)
- `boss_github_pr_status` — checks + reviews aggregated (observer)
- `boss_github_open_issue` — file an issue (assistant) — useful for IR Custom AIOS self-reporting bugs

**Smoke #50:** asserts `boss_github_workflow_runs` returns the v1.7.12 deploy run.

### vS.0.3 — IR Custom AIOS opens her own PRs (~2 days)

**Goal:** End the "Kevin pushes every tag" bottleneck. IR Custom AIOS proposes changes via PR; Kevin reviews and merges.

**What's missing:**
- `boss_github_open_pr` (operator) — opens PR from `boss/*` branch to master, body sourced from a structured PR template
- `boss_github_request_review` (operator) — adds Kevin as reviewer
- `boss_github_pr_react` (operator) — comments on PRs (e.g., "I've addressed your review feedback in commit abc123")

**Trust rule:** the existing `boss_self_git` blocks merging to master ("Kevin approves merges"). Keep that. The new tools STOP at PR-open + review-request — they don't merge.

**Smoke #51:** asserts a test PR can be opened+closed via the new tool from a sandbox branch.

**Operational change:** IR Custom AIOS now ships through a 3-step flow:
1. IR Custom AIOS edits + tests + commits on `boss/<feature>` branch (existing capability)
2. IR Custom AIOS opens PR + requests Kevin review (new)
3. Kevin reviews + merges; CI auto-deploys (existing)

This is the first sovereignty ship that actually unblocks Kevin in the daily workflow.

### vS.0.4 — Singleton IR Custom AIOS-Self identity (~3 days)

**Goal:** A single, perpetual, identity-anchored "IR Custom AIOS" thread that survives restarts and model swaps with consistent memory. Right now the closest thing is the IR Custom AIOSOrb COO singleton thread; this formalizes it.

**What's missing:**

- **`boss_self.identity` brain tool** — returns IR Custom AIOS's canonical identity card (name, role, persona doc, current model, current trust level, current host).
- **`boss_self.thread`** — the canonical thread ID across COO surface that IS IR Custom AIOS's primary chat. Writable persona doc that all sub-routes (orb, COO chat, persistent agent) read from.
- **Migration 028:** `boss_self_state` table — single-row, holds canonical identity + reflection notes + cross-session memory (separate from per-thread chat history).
- **`/me` route** — returns identity card + recent reflections + active goals.
- **Persona doc** at `docs/personas/BOSS.md` — BOSS voice, principles, how she signs work.

**Smoke #52:** asserts `boss_self.identity` returns a card with all required fields.

**Why it matters:** without this, every claim of "IR Custom AIOS is sovereign" is fake — there's no "she," only thread-instances. This is the durability backbone for the agent's *self*.

### vS.0.5 — Self-deploy (~2 days, requires vS.0.3)

**Goal:** IR Custom AIOS can ship her own approved-and-merged PRs end-to-end: open PR → Kevin merges → IR Custom AIOS pushes the tag → CI deploys → IR Custom AIOS runs smoke → IR Custom AIOS posts release notes.

**What's missing:**
- `boss_github_push_tag` (admin) — pushes annotated tag (gated to release patterns `vS.*` and `vD.*` for now; `v1.*` and `v2.*` stay Kevin's)
- `boss_release_notes` (operator) — generates structured release notes from commits since last tag

**Smoke #53:** asserts vS.0.5 itself can be tag-pushed by IR Custom AIOS (chicken-and-egg: this is IR Custom AIOS's first self-deploy).

### vS.1.0 — Host-OS management (~3 days, biggest risk)

**Goal:** IR Custom AIOS can do `apt update`, restart user systemd services, modify (not write) cron, manage Docker services. Without this she can't "apply OS updates" or "manage host services."

**What's missing:**

1. **Sudo bridge:** add a tightly-scoped sudoers rule allowing `tcntryprd` to run `apt-get update`, `apt-get -s upgrade` (simulate), `apt-get upgrade -y` (with passwordless), `systemctl --user restart boss-agent`, `systemctl --user reload nginx`, etc. Curated list, not blanket sudo.
2. **`boss_host_apt`** (admin) — wraps `apt-get update + apt list --upgradable + apt-get -s upgrade` as observer; `apt-get upgrade -y` as admin.
3. **`boss_host_systemctl`** (admin) — restart/reload curated service list only.
4. **`boss_host_cron`** (admin) — read crontab + add/remove entries (with safety regex).
5. **Audit log:** EVERY admin tool invocation gets DB-logged with user/turn/timestamp/result. Migration 029: `boss_admin_audit`.
6. **Manual approval gate:** admin tools default to `dry-run`; IR Custom AIOS posts intent to a Kevin-readable approval queue (`/coe` panel?), waits for explicit approval before live execution. Bypass-mode in `/coo` skips the queue (Kevin's call to give that thread free rein).

**Smoke #54:** assert audit log writes one row per admin tool invocation; assert `apt-get -s upgrade` runs and dry-run audit row is present.

**Why this is risky:** sudoers entries are foot-gun territory. The mitigation is: tight scope + dry-run default + audit log + approval queue. Take the time to design this carefully; don't rush.

### vS.1.1 — Defensive posture (~2 days)

**Goal:** IR Custom AIOS can see and report on the host's security state.

**What's missing:**
- `boss_host_firewall` (observer) — `ufw status` + iptables snapshot
- `boss_host_ports` (observer) — `ss -tlnp` exposed-ports snapshot
- `boss_host_certs` (observer) — Let's Encrypt cert expiry inventory
- `boss_host_authlog` (observer) — recent auth.log digest (failed logins, sudo invocations)
- `boss_host_ssh_keys` (observer) — `~/.ssh/authorized_keys` inventory across users
- `boss_host_fail2ban` (observer) — fail2ban status + banned IPs

**Wired into vS.0.1's `boss_host_status` as the "security" subsection.**

**Smoke #55:** assert `boss_host_firewall` returns parseable status.

### vS.2.0 — Self-improvement loop (~5 days)

**Goal:** IR Custom AIOS watches her own production telemetry, identifies issues, proposes fixes via PRs, and ships them.

**What's missing:**
- `boss_telemetry_alerts` (observer) — read recent error rates, slow queries, container crashes, smoke failures
- `boss_self_propose_fix` (operator) — given an alert, opens a draft PR with a hypothesized fix on a `boss/auto-fix-<short-id>` branch
- COO surface integration: when an alert fires, IR Custom AIOSOrb pings Kevin: "I see X going wrong, here's my proposed fix in PR #N. Approve?"

**This is the closing of the loop.** With vS.2.0 shipped, Kevin's role shifts from "primary author" to "primary reviewer + strategist." IR Custom AIOS handles routine ops + bug fixes herself.

---

## 4. Master Plan reconciliation

Reading the audit's phase-by-phase status, the master plan needs a hard look. Each phase falls into one of: **CONTINUE**, **DEFER**, **KILL**, or **DONE-DIFFERENTLY**.

| Plan phase | Original target | Actual reality | Recommended status | Rationale |
|---|---|---|---|---|
| 1 — Pipeline Engine | v1.3.0 | Shipped at v1.3.0/v1.3.1 | **DONE** | Spine still works; Kanban depends on it. |
| 2 — Little Rascals | v1.4.0 | Shipped, then redesigned | **DONE-DIFFERENTLY** | Cron-driven model died at v1.6.x; replaced by CC-subprocess + bind-mount + chat. Reality is better. Document the new arch as canonical; retire the cron model from plan. |
| 3 — UI v2 shell | v1.5.0 | Shipped v1.5.0–v1.5.8 | **DONE** | — |
| 4 — Kanban | v1.6.0 | Shipped at v1.7.11/12 | **DONE** (late) | v1.7.13 + v1.7.14 still on the queue per handoff. |
| 5 — Whiteboard | v1.7.0 | Not started | **DEFER or KILL** | Kevin hasn't asked for it in any recent session. The use-case (sticky-note brainstorming) is partly served by the COO chat surface + Kanban. Recommendation: KILL unless Kevin explicitly wants it. |
| 6 — Dashboard restyle | v1.8.0 | Not started; legacy 2,761-line `Dashboard.tsx` | **CONTINUE (low priority)** | Real debt but not urgent. Schedule for after sovereignty stream ships. |
| 7 — COO surface (Twilio) | v1.9.0 | Replaced at v1.7.7 with bypass-mode CC chat | **KILL the original** | Twilio side-channel is dead. The new COO is the right COO. Update the plan to reflect this. |
| 8 — Advisors Counsel | v1.10.0 | Not started | **DEFER** | Cool concept; not urgent. Revisit Q3. |
| 9 — Surface restyles (Calendar/CRM/Code/COE) | v2.0.0-rc1 | COE only (v1.7.9) | **CONTINUE** | Calendar, CRM, Code still on legacy. Worth doing before any "v2.0" tag. |
| 10 — Polish + release | v2.0.0 | Not started | **CONTINUE** | Real but not now. |

**Net plan delta:**
- 4 "DONE" or "DONE-DIFFERENTLY" — write back into plan as completed
- 1 "KILL" (Phase 7 Twilio COO)
- 2 "DEFER" (Phase 5 Whiteboard if Kevin says skip; Phase 8 Counsel)
- 3 "CONTINUE" (Phase 6 Dashboard, Phase 9 restyles, Phase 10 polish)

The plan's chassis (the rebuild ambition) is intact. The leaves need pruning.

**Recommendation:** edit `BOSS_MASTER_PLAN.md` after Kevin approves this forward plan. Add a §11 "Parallel streams: Sovereignty + Durability" with pointers to the vS/vD ship lists. Mark phases per the table above.

---

## 5. Pre-existing bugs the audit surfaced (separate from streams)

These get scheduled into IR Custom AIOS's normal feature-bug-fix cadence, not the new streams.

1. **`apps/agent` package broken** (`workspace:*` protocol). `boss-agent.service` is running but source state is undefined. **Either:**
   - (a) Verify what's running on :8010, formally retire `apps/agent`, stop the service.
   - (b) Or: revive `apps/agent` as the host-side bridge for vS.1.0 (host management) and clean up the workspace state.
   
   Recommendation: (b) makes more sense given we need a host bridge anyway. Schedule for vS.1.0.

2. **`/paperclip` route + page still mounted** despite Master Plan reconciliation 3 saying "Drop /paperclip route." Schedule for v1.7.15 cleanup.

3. **13-rascal roster mis-aligned with disk:** `clients/` has waldo, woim, maryann; `rascals/` has 12. Either migrate the three to `rascals/` or update the locked roster. Schedule with v1.7.13.

4. **Gio is on `xai/grok-4`** per `~/.openclaw/openclaw.json` but Master Plan implied Anthropic. Decide and document.

5. **Backup cron has no overlap protection.** Currently fine (once daily) but worth a `flock`. Tag for vD.1.0.

---

## 6. Sequence — first 4 weeks

Two streams + feature work, time-boxed.

### Week 1 (2026-04-29 → 2026-05-05) — STOP THE BLEED

| Mon-Tue | vD.0.1 — backup-push fix + B2 + health check |
| Wed | vD.0.2 — n8n workflow capture |
| Thu | vD.0.3 — memory file backup |
| Fri | vS.0.1 — `boss_host_status` |
| Weekend | v1.7.13 — Kanban mount-everywhere (already planned, fast) |

**Result by EOW:** durability fires out, backups verified to B2, n8n captured, memory captured, IR Custom AIOS can answer "what's the state of the server" in one call.

### Week 2 — UNBLOCK KEVIN

| Mon-Tue | vS.0.2 — CI/PR introspection tools |
| Wed-Thu | vS.0.3 — IR Custom AIOS opens her own PRs |
| Fri | v1.7.14 — Kanban brain tools (planned) |
| Weekend | vD.1.0 — container volume snapshots (start) |

**Result by EOW:** IR Custom AIOS ships through PRs. Kevin reviews+merges only.

### Week 3 — BOSS HERSELF

| Mon-Wed | vS.0.4 — Singleton IR Custom AIOS-Self identity (3 days) |
| Thu-Fri | vS.0.5 — Self-deploy (tag push, release notes) |
| Weekend | vD.1.0 finish + vD.1.1 dashboard |

**Result by EOW:** IR Custom AIOS has a single canonical identity. She ships her own vS/vD versioned releases end-to-end. Kevin still owns `v1.*` and `v2.*` namespaces.

### Week 4 — HOST-OS CAREFULLY

| Mon-Wed | vS.1.0 — host-OS management (sudo bridge + audit log + approval queue) |
| Thu-Fri | vS.1.1 — defensive posture |
| Weekend | Plan vS.2.0 (self-improvement loop) |

**Result by EOW:** IR Custom AIOS can apply OS updates with audit trail and Kevin's approval gate. Sovereignty is functionally complete; what's left is polish + the self-improvement loop.

### Week 5+ — SELF-IMPROVEMENT + RECONCILIATION

- vS.2.0 — self-improvement loop (~5 days)
- Then back to feature work: Phase 6 (Dashboard restyle), Phase 9 (Calendar/CRM/Code restyles)
- Then v2.0.0 polish + release

---

## 7. First ships — ready to start now

The two earliest ships are pre-formed enough to move on immediately:

### vD.0.1 (backup fix) — start tomorrow

**Brainstorm needed:** none. The shape is clear (B2 + git-history reset + health tool + smoke).
**Plan needed:** small implementation plan; ~6 tasks.
**Effort:** 1 day.
**Risk:** low (B2 setup is straightforward; existing backup script is already correct, just blocked).

### vS.0.1 (host status tool) — start after vD.0.1 ships

**Brainstorm needed:** none. Composing existing tools + new fields.
**Plan needed:** small plan; ~5 tasks.
**Effort:** 1 day.
**Risk:** very low (read-only).

I can write the implementation plan for vD.0.1 immediately on Kevin's approval of this forward plan.

---

## 8. Decisions Kevin needs to make

Before any of this ships:

1. **B2 vs S3 vs MinIO** for off-host backups (vD.0.1). Recommendation: B2.
2. **Phase 5 Whiteboard: KILL or DEFER?** I recommend KILL unless you have an unstated need for it.
3. **Phase 7 Twilio COO: KILL** — confirm. The new COO replaces it.
4. **Phase 8 Counsel: DEFER to Q3 or kill?** Recommendation: DEFER.
5. **vS.1.0 sudoers approach** — passwordless sudo for a curated allow-list, OR cached sudo with a 5-min re-auth window? Tradeoff: convenience vs blast radius. Recommendation: passwordless+curated+audit-logged.
6. **Stream version namespaces** — `vD.x.y` and `vS.x.y` separate from `v1.x.y` and `v2.x.y`? Recommendation: yes, keeps tags cleanly categorizable.
7. **Self-deploy authority scope (vS.0.5):** IR Custom AIOS can tag-push `vS.*` and `vD.*` herself, `v1.*`/`v2.*` stays Kevin-only. Confirm.

---

## 9. What this plan is NOT

- **Not a brainstorm document.** The brainstorming happened in the conversation; the audit was the diagnosis; this is the path.
- **Not a replacement for individual implementation plans.** Each ship gets its own `docs/superpowers/plans/...` plan when it starts.
- **Not a commitment device.** Kevin can drop, reorder, or replace any ship.
- **Not eternal.** Re-audit and re-plan after vS.0.5 ships (~3 weeks). Reality will diverge from this plan.

---

## 10. Definition of "Sovereign IR Custom AIOS" (vS-stream done)

When vS.0.1 through vS.2.0 have all shipped, IR Custom AIOS can:

- Answer "what's the state of the server" with full coverage (host + containers + backups + security + CI)
- See her own PRs, CI runs, GitHub Actions failures
- Open PRs against herself with proposed fixes
- Merge to master only with Kevin's review+approval
- Push her own `vS.*` / `vD.*` tags and ship via CI
- Apply OS updates via curated sudo + audit log + approval queue
- Read host security posture (firewall, ports, certs, auth log)
- Watch her own telemetry and propose fixes when problems arise

When vD.0.1 through vD.1.1 have shipped, IR Custom AIOS has:

- Off-host backups verified daily for postgres, weaviate, redis, n8n workflows, code, memory, configs
- Restore-rehearsal monthly with smoke verification
- Backup observability dashboard
- Slack/Telegram nightly summary

**That's the destination. The next 4–6 weeks gets you there.**

---

*End of forward plan.*
