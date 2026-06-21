# BOS v2 — Web Dockerfile
# Multi-stage: Node builds the React bundle, nginx alpine serves static files.
# The build injects VITE_API_URL at build time so the browser bundle hits the
# correct API endpoint. Override with build arg in CI/CD.

# ---- Stage 1: build ----
FROM node:20-alpine AS builder

WORKDIR /app

# Copy workspace manifests for layer caching
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./

COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/

RUN npm ci --ignore-scripts

# Copy source for packages web depends on
COPY packages/core/src packages/core/src
COPY apps/web apps/web

# Build arg lets us inject the API URL without baking a hardcoded value.
# Default points to the API container name as resolved inside Docker network.
ARG VITE_API_URL=http://localhost:8001
ENV VITE_API_URL=${VITE_API_URL}

RUN npm run build --workspace=apps/web

# ---- Stage 2: nginx static server ----
FROM nginx:1.27-alpine AS runner

# Remove default nginx config
RUN rm /etc/nginx/conf.d/default.conf

# Copy our nginx config tuned for React SPA (all routes -> index.html)
COPY apps/web/nginx.conf /etc/nginx/conf.d/boss.conf

# Copy the built bundle from the builder stage
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html

# nginx runs as root by default inside the container, which is fine for port 80.
# We keep it default to avoid permission issues with /tmp and /var/cache/nginx.

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --spider -q http://127.0.0.1:80/ || exit 1

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
