# Multi-stage build: install → build (Prisma client + Next.js) → slim runtime.
ARG BASE_IMAGE=node:22-bookworm-slim

FROM ${BASE_IMAGE} AS base
# Prisma's schema engine (migrations) links against OpenSSL 3; the app itself uses
# Prisma's Wasm query compiler and needs no native engine. Slim images lack libssl.
RUN if ! ls /usr/lib/*/libssl.so.3 >/dev/null 2>&1; then \
      apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*; \
    fi

FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY . .
RUN npx prisma generate && npx next build && npm prune --omit=dev --no-audit --no-fund

FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/server.ts /app/tsconfig.json /app/next.config.ts /app/prisma.config.ts ./
COPY --from=build --chown=node:node /app/scripts ./scripts
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# The custom server (Next.js + WebSocket) runs TypeScript directly via tsx.
CMD ["npx", "tsx", "server.ts"]
