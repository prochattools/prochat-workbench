# Multi-stage build for BuildFlow production topology
# Builds relay, web, and proxy in separate stages; runs all three in production container

# Build stage 1: relay
FROM node:20-alpine AS relay-builder

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/bridge ./packages/bridge
COPY packages/shared ./packages/shared

RUN npm install -g pnpm && pnpm install --frozen-lockfile

RUN pnpm --dir packages/shared build
RUN pnpm --dir packages/bridge build

# Build stage 2: web
FROM node:20-alpine AS web-builder

WORKDIR /app

RUN apk add --no-cache python3 make g++ openssl

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web ./apps/web
COPY packages/shared ./packages/shared
COPY packages/cli ./packages/cli
COPY packages/bridge ./packages/bridge

RUN npm install -g pnpm && pnpm install --frozen-lockfile

WORKDIR /app/apps/web
# Generate Prisma client
RUN pnpm exec prisma generate
# Build Next.js app
RUN pnpm build

# Build stage 3: proxy
FROM node:20-alpine AS proxy-builder

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/ ./packages/

RUN npm install -g pnpm && pnpm install --frozen-lockfile

WORKDIR /app/packages/proxy
RUN pnpm build

# Runtime stage: production topology
FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache python3 make g++ openssl

# Create non-root user
RUN addgroup -S buildflow && adduser -S buildflow -G buildflow -s /sbin/nologin

# Create data directory
RUN mkdir -p /var/lib/buildflow && chown -R buildflow:buildflow /var/lib/buildflow

# Copy workspace files for dependency installation
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/proxy/package.json ./packages/proxy/package.json
COPY packages/bridge/package.json ./packages/bridge/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY apps/web/package.json ./apps/web/package.json

# Install pnpm and dependencies (all deps needed by all packages)
RUN npm install -g pnpm && pnpm install --frozen-lockfile

# Copy relay artifacts
COPY --from=relay-builder /app/packages/bridge/dist ./packages/bridge/dist
COPY --from=relay-builder /app/packages/bridge/package.json ./packages/bridge/package.json

# Copy web artifacts (must include all next/prisma artifacts)
COPY --from=web-builder /app/apps/web/.next ./apps/web/.next
COPY --from=web-builder /app/apps/web/package.json ./apps/web/package.json
COPY --from=web-builder /app/apps/web/prisma ./apps/web/prisma

# Copy shared dependencies (required by both relay and web)
COPY --from=web-builder /app/packages/shared ./packages/shared

# Copy proxy artifacts
COPY --from=proxy-builder /app/packages/proxy/dist ./packages/proxy/dist
COPY --from=proxy-builder /app/packages/proxy/package.json ./packages/proxy/package.json

# Switch to non-root user
USER buildflow

# Expose public proxy port only
EXPOSE 3054

# Production environment defaults
ENV NODE_ENV=production
ENV BRIDGE_PORT=3053
ENV WEB_PORT=3055
ENV PORT=3054
ENV RELAY_DATA_DIR=/var/lib/buildflow
ENV DATABASE_URL=file:/var/lib/buildflow/buildflow.db
ENV RELAY_ENABLE_DEFAULT_TOKENS=false

# Health check: probe proxy /ready endpoint
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "const http = require('http'); http.get('http://localhost:3054/ready', (r) => process.exit(r.statusCode === 200 ? 0 : 1))" || exit 1

# Start proxy (which starts relay and web as child processes)
CMD ["node", "./packages/proxy/dist/index.js"]
