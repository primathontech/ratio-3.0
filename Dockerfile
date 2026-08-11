# Ratio container (ADR-012: Hono on a container, pg -> Neon). The edge is Cloudflare,
# NOT in this image. One image serves either role, chosen at runtime by RATIO_SERVICE:
# unset/anything -> the public data-plane origin; "admin-api" -> the authed control plane.
# Install with Bun (the repo's lockfile is bun.lock; package-lock.json was removed).
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
# Every workspace manifest must be present so `bun install` can create the @ratio/*
# node_modules symlinks; the source they point to arrives via `COPY . .` in runtime.
COPY packages/builder-core/package.json ./packages/builder-core/package.json
COPY packages/builder-registry/package.json ./packages/builder-registry/package.json
COPY packages/builder-render/package.json ./packages/builder-render/package.json
COPY packages/control-plane-client/package.json ./packages/control-plane-client/package.json
COPY packages/data-db/package.json ./packages/data-db/package.json
COPY packages/data-provisioning/package.json ./packages/data-provisioning/package.json
COPY packages/data-repo/package.json ./packages/data-repo/package.json
COPY packages/edge-core/package.json ./packages/edge-core/package.json
COPY packages/gokwik/package.json ./packages/gokwik/package.json
COPY packages/observability/package.json ./packages/observability/package.json
COPY packages/observability-core/package.json ./packages/observability-core/package.json
COPY packages/observability-edge/package.json ./packages/observability-edge/package.json
COPY packages/observability-tracing/package.json ./packages/observability-tracing/package.json
COPY apps/admin-api/package.json ./apps/admin-api/package.json
COPY apps/admin-web/package.json ./apps/admin-web/package.json
COPY apps/edge/package.json ./apps/edge/package.json
COPY apps/origin/package.json ./apps/origin/package.json
RUN bun install --frozen-lockfile

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# admin-api listens on 80 (ECS Express defaults new services' target port to 80); the
# origin keeps 8080 (its target group is 8080). Each role matches its gateway target.
CMD ["sh", "-c", "if [ \"$RATIO_SERVICE\" = \"admin-api\" ]; then export PORT=80; exec npx tsx apps/admin-api/src/server.ts; else exec npx tsx apps/origin/src/server.ts; fi"]
