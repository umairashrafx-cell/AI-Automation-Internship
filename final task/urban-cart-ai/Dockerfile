# =============================================================================
# UrbanCart AI backend
# =============================================================================
# No build stage is needed: Node 22.6+ runs TypeScript directly via native type
# stripping, so the image contains the source as written. That keeps the image
# small and means the code running in production is the code in the repository -
# no source maps, no transpilation step to diverge.
# =============================================================================

FROM node:24-alpine

# dumb-init gives us correct signal handling, so SIGTERM reaches Node and the
# graceful shutdown in server.ts actually runs. Without it the database is
# closed abruptly on every deploy.
RUN apk add --no-cache dumb-init

WORKDIR /app

# Dependencies first, so a source change does not invalidate the install layer.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY backend/  ./backend/
COPY database/ ./database/
COPY frontend/ ./frontend/
COPY scripts/  ./scripts/
COPY tsconfig.json ./

# The knowledge base is bind-mounted by compose so documents can be updated
# without rebuilding; this copy is the fallback for a standalone image.
COPY knowledge-base/ ./knowledge-base/

# Writable runtime directory for the dry-run outbox and any local cache.
RUN mkdir -p /app/data/outbox && chown -R node:node /app/data

USER node

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "backend/src/server.ts"]
