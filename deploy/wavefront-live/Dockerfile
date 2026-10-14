# Wavefront live engine worker — PENDING OWNER APPROVAL. Not built, not pushed, not deployed.
# See docs/WAVEFRONT_LIVE_ENGINE.md ("Where it runs", "Decisions").
#
# Build from the repository root:
#   docker build -f deploy/wavefront-live/Dockerfile -t wavefront-live .
# Run (file sink on a volume):
#   docker run -v wavefront:/data wavefront-live --mode live --out /data/stream.jsonl --stats /data/stats.json
# Postgres sink (needs the pending migration applied and DATABASE_URL as a secret):
#   docker run -e DATABASE_URL=... wavefront-live --mode live --sink postgres --stats /data/stats.json
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production
# The worker needs only the engine's sources and their runtime dependencies.
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod=false --ignore-scripts
COPY tsconfig.json ./
COPY lib ./lib
COPY scripts/oct10-coverage ./scripts/oct10-coverage
COPY scripts/wavefront-live ./scripts/wavefront-live

# Memory measured 2026-10-14 (docs §8): ~150 MB RSS calm, 381 MB in the Oct 10 crash replay; cap the heap.
ENV NODE_OPTIONS=--max-old-space-size=384
ENTRYPOINT ["npx", "tsx", "scripts/wavefront-live/run.ts"]
CMD ["--mode", "live", "--out", "/data/stream.jsonl", "--stats", "/data/stats.json"]
