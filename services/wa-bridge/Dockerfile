# BOS wa-bridge — Baileys WhatsApp bridge.
#
# NO Chromium. NO puppeteer. NO browser deps. That is the entire point of this
# rewrite: Baileys talks the WhatsApp multi-device protocol over a websocket,
# so the runtime is plain node. The image is ~150MB instead of ~1.2GB.
#
# Stage 1: compile TypeScript.
# Stage 2: slim runtime, non-root, auth + rolling stores on a volume.

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim AS runtime

# dumb-init = PID 1 signal handling / zombie reaping. wget = HEALTHCHECK probe.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      wget \
      dumb-init \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    WA_BRIDGE_DATA_DIR=/data/session \
    PORT=2785

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Baileys auth state (/data/session/auth) + rolling message/contact stores live
# on the volume, owned by the unprivileged node user.
RUN mkdir -p /data/session && chown -R node:node /data /app
VOLUME ["/data/session"]

USER node
EXPOSE 2785

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD wget --spider -q http://localhost:2785/healthz || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
