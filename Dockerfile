# Origin container image (ADR-012: Hono on a scale-to-zero container).
# NOTE: on the real stack the container runs the ORIGIN only — the edge is
# Cloudflare, not our code. server.ts currently starts both (POC); the edge
# split is a later slice.
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 9090
# tsx runs the TS entrypoint directly (zero-build). Swap to a compiled dist/ later.
CMD ["npx", "tsx", "src/server.ts"]
