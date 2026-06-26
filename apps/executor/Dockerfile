# BOS v2 — Executor Dockerfile
#
# The executor is the container where production workloads run: ffmpeg
# muxing, git pushes, social-post pipelines, scheduled cron jobs, and the
# job-queue watcher that chat-CC dispatches to.
#
# Goal: every host-side script Kevin's agents run today (post-social.sh,
# wake-agent.sh, podcast pipeline, etc.) becomes runnable inside this
# container without binary or path drift. That unlocks the
# containers-all-the-way architecture (v1.7.x) and the shippable BOS
# package (v2.0.0) — friend's VPS pulls the same image and it works.
#
# Mounts (set in docker-compose.yml):
#   - ~/.claude       — Claude Code subscription auth
#   - ~/.claude.json  — MCP config + project entries
#   - ~/rascals       — per-rascal trees (CLAUDE.md, playbooks, content)
#   - ~/outsiders     — per-outsider trees
#   - ~/sp-brand      — voice guide + recent-posts log
#   - boss_data     — named volume for generated assets (mp3s, images)
#
# v1.7.0 ships the image; v1.7.1 wires Ponyboy's flow into it; v1.7.2
# adds the chat-CC → executor job-queue bridge.
#
# Known followups:
#   - gog (Go binary, ~22MB) is not yet in the image. Sunday post still
#     runs from host until gog ships in v1.7.1.
#   - cron daemon is installed but not started by default; entrypoint
#     swaps to `crond -f -d 8` once jobs land in /etc/crontabs.

FROM node:20-alpine

# System toolchain for production scripts
RUN apk add --no-cache \
      bash \
      curl \
      git \
      python3 \
      py3-pip \
      ffmpeg \
      tmux \
      busybox-suid \
      tzdata \
      ca-certificates \
      jq

# Claude Code CLI — same version pin as boss_api so chat-CC and
# executor-claude can never drift apart on subscription auth.
RUN npm install -g @anthropic-ai/claude-code@2.1.119

# Workspace root inside the container. Bind-mounts attach here.
WORKDIR /home/tcntryprd

# Pre-create the mount targets so an unmounted run still produces a
# legible error rather than a missing-directory crash.
RUN mkdir -p \
      /home/tcntryprd/.claude \
      /home/tcntryprd/rascals \
      /home/tcntryprd/outsiders \
      /home/tcntryprd/sp-brand \
      /home/tcntryprd/boss-dev/productions \
      /var/log/boss-executor

# Default model env so any in-container claude spawn that doesn't
# specify --model still gets Sonnet 4.6 — house default per v1.7.0.
ENV BOSS_DEFAULT_MODEL=claude-sonnet-4-6
ENV TZ=America/Chicago

# v1.7.2 — internal crond. Schedule lives in apps/executor/crontab.social
# (the Ponyboy social pipeline). Owned by node:node so crond running as
# uid 1000 can read it without scanning other users' crontabs. Remove
# the busybox-default /etc/crontabs/root placeholder so non-root crond
# doesn't log "Permission denied" trying to read it on every cycle.
COPY --chown=node:node apps/executor/crontab.social /etc/crontabs/node
RUN rm -f /etc/crontabs/root

# Healthcheck: every binary the social pipeline depends on must be
# callable. Run via bash -c so `command` (a shell builtin) resolves.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bash -c 'command -v claude >/dev/null && command -v ffmpeg >/dev/null && command -v python3 >/dev/null && command -v gog >/dev/null' || exit 1

# Entrypoint: busybox crond in foreground. -L /dev/stderr routes its
# own log to docker's container logs so `docker logs boss_executor`
# shows the schedule daemon's lifecycle. The cron jobs themselves
# write to the bind-mounted log file in productions/output/...
CMD ["crond", "-f", "-L", "/dev/stderr"]
