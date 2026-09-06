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
# Terms-page hash watcher — fetches each venue's official terms/redemption page,
# hashes visible text, and records a change (+ a terms_page_changed event) only
# when the hash moves. Runs BEFORE alarms so a terms change is in the corpus the
# alarm checker evaluates this same tick. Non-fatal — an external-page hiccup must
# never fail the capacity/flows tick.
/opt/homebrew/bin/node scripts/watch-venue-terms.mjs || echo "terms:watch failed (non-fatal)"
# Venue failure-pattern alarms LAST — evaluates the corpus we just refreshed
# (no chain reads) and notifies on new flags. Non-fatal: an alarm-check hiccup
# must never fail the capacity/flows tick.
/opt/homebrew/bin/node scripts/check-venue-alarms.mjs || echo "alarms:check failed (non-fatal)"
# Score any due CALLED-IT receipts against the snapshots we just refreshed (no
# chain reads). Non-fatal — a scoring hiccup must never fail the capacity tick.
/opt/homebrew/bin/node scripts/score-user-receipts.mjs || echo "receipts:score failed (non-fatal)"
