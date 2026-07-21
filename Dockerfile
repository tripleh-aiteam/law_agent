# Law Agent — on-prem runtime image
#
# Multi-stage so the final image carries only what the server needs:
# the standalone Next.js bundle, the corpus seed, and the embedding weights.
#
# The embedding model is downloaded at BUILD time and baked in, so the
# container never reaches huggingface.co at runtime. That matters for a
# firm server that may sit behind a restrictive egress policy.

# ---------------------------------------------------------------- deps ----
FROM node:24-slim AS deps
WORKDIR /app

# libc6-compat isn't needed on -slim (glibc), but onnxruntime wants these.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

# --------------------------------------------------------------- build ----
FROM node:24-slim AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Next reads env at build time for some optimizations; none of our secrets
# are build-time, so we only disable telemetry here.
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# Pre-download the embedding weights into a cache directory we can copy into
# the runtime image. Doing this in the builder keeps the download out of the
# critical path on first user query.
ENV TRANSFORMERS_CACHE=/app/.hf-cache
RUN node -e "\
  (async () => { \
    const { pipeline } = await import('@huggingface/transformers'); \
    await pipeline('feature-extraction', 'Xenova/multilingual-e5-base', { dtype: 'fp32' }); \
    console.log('embedding model cached'); \
  })().catch((e) => { console.error(e); process.exit(1); });"

# ------------------------------------------------------------- runtime ----
FROM node:24-slim AS runner
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV TRANSFORMERS_CACHE=/app/.hf-cache
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Run unprivileged. node:24-slim already ships a `node` user (uid 1000).
RUN mkdir -p /app/.hf-cache && chown -R node:node /app

# Standalone output: server.js plus only the node_modules actually reached.
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

# Embedding weights.
COPY --from=builder --chown=node:node /app/.hf-cache ./.hf-cache

# The corpus seed + migration tooling. `standalone` does not include these,
# and the migration script runs inside this container.
COPY --from=builder --chown=node:node /app/src/data ./src/data
COPY --from=builder --chown=node:node /app/scripts ./scripts
COPY --from=builder --chown=node:node /app/src/lib ./src/lib
COPY --from=builder --chown=node:node /app/node_modules/tsx ./node_modules/tsx
COPY --from=builder --chown=node:node /app/tsconfig.json ./tsconfig.json

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS http://localhost:3000/api/health || exit 1

CMD ["node", "server.js"]
