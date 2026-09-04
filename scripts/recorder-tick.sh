#!/bin/sh
# One recorder tick, run hourly by launchd (com.membrane.venue-recorder).
# Capacity first (cheap, must not be starved), then flows (heavier getLogs;
# --chunk kept small for the free-tier RPC — the cursor makes hourly
# increments tiny, and a timeout on one venue is non-fatal and resumes).
cd "$(dirname "$0")/.." || exit 1
echo "=== recorder tick $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
/opt/homebrew/bin/node scripts/record-venue-liquidity.mjs
/opt/homebrew/bin/node scripts/record-venue-flows.mjs --chunk 2000
