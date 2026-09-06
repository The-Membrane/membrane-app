#!/bin/sh
# One recorder tick, run hourly by launchd (com.membrane.venue-recorder).
# Capacity first (cheap, must not be starved), then flows (heavier getLogs;
# --chunk kept small for the free-tier RPC — the cursor makes hourly
# increments tiny, and a timeout on one venue is non-fatal and resumes).
cd "$(dirname "$0")/.." || exit 1
echo "=== recorder tick $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
/opt/homebrew/bin/node scripts/record-venue-liquidity.mjs
/opt/homebrew/bin/node scripts/record-venue-flows.mjs --chunk 2000
# Venue news last (external RSS; upsert-idempotent). Non-fatal — a Google News
# hiccup must never fail the capacity/flows tick, so swallow its exit code.
/opt/homebrew/bin/node scripts/fetch-venue-news.mjs || echo "news:fetch failed (non-fatal)"
# Refresh tracked strat positions (batched multicall reads; the /strats board
# serves this cache + freshness stamp). Non-fatal.
/opt/homebrew/bin/node scripts/refresh-strat-positions.mjs || echo "strats:refresh failed (non-fatal)"
# Venue failure-pattern alarms LAST — evaluates the corpus we just refreshed
# (no chain reads) and notifies on new flags. Non-fatal: an alarm-check hiccup
# must never fail the capacity/flows tick.
/opt/homebrew/bin/node scripts/check-venue-alarms.mjs || echo "alarms:check failed (non-fatal)"
