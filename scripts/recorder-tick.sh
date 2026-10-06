#!/bin/sh
# One recorder tick, run hourly by launchd (com.membrane.venue-recorder).
# Capacity first (cheap, must not be starved), then flows (heavier getLogs;
# --chunk kept small for the free-tier RPC — the cursor makes hourly
# increments tiny, and a timeout on one venue is non-fatal and resumes).
cd "$(dirname "$0")/.." || exit 1
echo "=== recorder tick $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
/opt/homebrew/bin/node scripts/record-venue-liquidity.mjs
# Slippage-bounded exit capacity: on-chain quotes (Curve get_dy / LitePSM tout)
# of what each depth market exits within 0.1-10% cost, one block. Non-fatal —
# a quote hiccup must never fail the capacity/flows tick.
/opt/homebrew/bin/node scripts/record-depth-curves.mjs || echo "depth-curves:record failed (non-fatal)"
/opt/homebrew/bin/node scripts/record-venue-flows.mjs --chunk 2000
# Bounded transaction-class reconciliation for NEW Curve depth events. Never
# blocks the next capacity tick if an archive RPC is unavailable.
/opt/homebrew/bin/node scripts/record-venue-event-drivers.mjs --limit 8 || echo "drivers:reconcile failed (non-fatal)"
# Venue news last (external RSS; upsert-idempotent). Non-fatal — a Google News
# hiccup must never fail the capacity/flows tick, so swallow its exit code.
/opt/homebrew/bin/node scripts/fetch-venue-news.mjs || echo "news:fetch failed (non-fatal)"
# Refresh tracked strat positions (batched multicall reads; the /strats board
# serves this cache + freshness stamp). Non-fatal.
/opt/homebrew/bin/node scripts/refresh-strat-positions.mjs || echo "strats:refresh failed (non-fatal)"
# Net APY at size: venue IRM params at one block + Merkl campaigns, local-first
# under .data/net-apy, with a change log (campaign lapsed early / end date moved /
# slope or fee changed). TypeScript via `--import tsx` so it needs no PATH lookup
# under launchd. Non-fatal — a Merkl or RPC hiccup must never fail the tick.
/opt/homebrew/bin/node --import tsx scripts/record-net-apy.ts || echo "netapy:record failed (non-fatal)"
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
