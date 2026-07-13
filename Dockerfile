# Ratio container (ADR-012: Hono on a container, pg -> Neon). The edge is Cloudflare,
# NOT in this image. One image serves either role, chosen at runtime by RATIO_SERVICE:
# unset/anything -> the public data-plane origin; "admin-api" -> the authed control plane.
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

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
CMD ["sh", "-c", "if [ \"$RATIO_SERVICE\" = \"admin-api\" ]; then export PORT=80; exec npx tsx services/admin-api/server.ts; else exec npx tsx apps/origin/server.ts; fi"]
