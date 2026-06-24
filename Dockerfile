# OpenSolvency — deployable HTTP ingress (the gate as an always-on service).
#
# Multi-stage: build the dist, then ship only runtime deps + dist on a slim Node 22
# image (node:sqlite needs >=22.5; no native build step). Runs as non-root and
# serves the ingress on 0.0.0.0 — which is SAFE only because the serve command
# fails closed without an ingress token (set OPENSOLVENCY_INGRESS_TOKEN).

# ---- build ----
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- runtime ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Production deps only.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# The compiled package.
COPY --from=build /app/dist ./dist

# Persistent sqlite store lives on a mounted volume.
ENV OPENSOLVENCY_DB=/data/opensolvency.db
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]

EXPOSE 8787

# Liveness via the /ready probe (no curl needed — Node 22 has global fetch).
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Bind all interfaces; the serve command refuses to start on a public interface
# without OPENSOLVENCY_INGRESS_TOKEN, so this fails closed by default.
CMD ["node", "dist/cli/index.js", "serve", "--host", "0.0.0.0", "--port", "8787"]
