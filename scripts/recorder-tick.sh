#!/bin/sh
# One recorder tick, run hourly by launchd (com.membrane.venue-recorder).
# Capacity first (cheap, must not be starved), then flows (heavier getLogs;
# --chunk kept small for the free-tier RPC — the cursor makes hourly
# increments tiny, and a timeout on one venue is non-fatal and resumes).
cd "$(dirname "$0")/.." || exit 1
unset recorder_tick_nonce
recorder_tick_nonce=$(/usr/bin/uuidgen)
echo "=== recorder tick $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
printf '@@recorder-stage-v1 event=tick-init utc=%s nonce=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$recorder_tick_nonce"
# These markers report process attempts only. A zero exit can still mean an
# issuer found no eligible evidence; outcomes live in the sealed research files.
recorder_stage_marker() {
  printf '@@recorder-stage-v1 event=%s stage=%s utc=%s nonce=%s%s\n' "$1" "$2" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$recorder_tick_nonce" "$3"
}
recorder_stage_run() {
  recorder_stage_name=$1
  shift
  recorder_stage_marker start "$recorder_stage_name" ''
  "$@"
  recorder_stage_rc=$?
  recorder_stage_marker end "$recorder_stage_name" " exit=$recorder_stage_rc"
  return "$recorder_stage_rc"
}
recorder_stage_skip() {
  recorder_stage_marker skip "$1" " reason=$2"
}
/opt/homebrew/bin/timeout 180s /opt/homebrew/bin/node scripts/record-venue-liquidity.mjs || echo "venue-liquidity:record failed or timed out (non-fatal)"
# Evaluate observed capacity changes before any slow research or DB stages.
# The later pass includes this tick's depth quotes and terms-page changes.
/opt/homebrew/bin/timeout 90s /opt/homebrew/bin/node scripts/check-venue-alarms.mjs || echo "alarms:early-check failed or timed out (non-fatal)"
# The half-hour local-cash job owns current capture and its issue/score ledger.
recorder_stage_skip carry_cash_local delegated_native_local_cash
recorder_stage_skip carry_cash_issue_local delegated_native_local_cash
recorder_stage_skip carry_cash_score_local delegated_native_local_cash
# The separate half-hour com.membrane.carry-morpho-flows job owns local Morpho
# capture and receipt reconciliation under one advisory lock.
# Exact frozen 25-route/67-subject aggregate cash proxy. A skipped tick is a
# real gap; the history command is separate and always retrospective.
# One disjoint UTC-day archive anchor per tick until the 120-day grid is full.
# The fixed UTC-day grid resumes by anchor key; old undeployed destinations are
# recorded as no_code, never silently omitted or filled with zero cash.
recorder_stage_run carry_cash_local_history /opt/homebrew/bin/timeout 240s /opt/homebrew/bin/node --import tsx scripts/record-carry-cash-local.mjs --history --lookback-hours 2880 --step-hours 24 --max-anchors 1 || echo "carry-cash:local-history failed or timed out (non-fatal)"
# Keep the unique Neon-only audit and Morpho V2 flow stages available for an
# explicit storage switch. Shared cash collectors run in their native job.
if [ "${CARRY_FORECAST_STORAGE:-local}" = "neon" ]; then
  # The quarter-hour cash-observation job runs these exact collectors, issue,
  # score, and audit commands against the same default destinations.
  recorder_stage_skip carry_route_vaults delegated_native_cash_observations
  recorder_stage_skip carry_direct_supply delegated_native_cash_observations
  recorder_stage_skip carry_spark_direct_supply delegated_native_cash_observations
  recorder_stage_skip carry_cash_issue delegated_native_cash_observations
  recorder_stage_skip carry_cash_model_issue delegated_native_cash_observations
  recorder_stage_skip carry_cash_score delegated_native_cash_observations
  recorder_stage_skip carry_cash_model_score delegated_native_cash_observations
  recorder_stage_skip carry_cash_audit delegated_native_cash_observations
  recorder_stage_run carry_cash_model_audit /opt/homebrew/bin/timeout 180s /opt/homebrew/bin/node --import tsx scripts/audit-carry-cash-model.mjs || echo "carry-cash-model:audit failed or timed out (non-fatal)"
  recorder_stage_run carry_morpho_v2_flows /opt/homebrew/bin/timeout 300s /opt/homebrew/bin/node scripts/record-carry-morpho-v2-flows.mjs --capture || echo "carry-morpho-v2-flows:capture failed or timed out (non-fatal)"
else
  recorder_stage_skip carry_neon_forecast local_storage_selected
fi
# Slippage-bounded exit capacity: on-chain quotes (Curve get_dy / LitePSM tout)
# of what each depth market exits within 0.1-10% cost, one block. Non-fatal —
# a quote hiccup must never fail the capacity/flows tick.
/opt/homebrew/bin/node scripts/record-depth-curves.mjs || echo "depth-curves:record failed (non-fatal)"
# Terms-page hash watcher — fetches each venue's official terms/redemption page,
# hashes visible text, and records a change (+ a terms_page_changed event) only
# when the hash moves. Runs BEFORE alarms so a terms change is in the corpus the
# alarm checker evaluates this same tick. Non-fatal — an external-page hiccup must
# never fail the capacity/flows tick.
/opt/homebrew/bin/node scripts/watch-venue-terms.mjs || echo "terms:watch failed (non-fatal)"
# Check active capacity, depth, and venue-event flags promptly, before slow
# research. The terms watcher above supplies same-tick terms-change events.
# This checker may notify on new flags; failures remain non-fatal.
/opt/homebrew/bin/node scripts/check-venue-alarms.mjs || echo "alarms:check failed (non-fatal)"
# General venue-flow DB refresh is optional while the local receipt chain runs.
if [ "${CARRY_FORECAST_STORAGE:-local}" = "neon" ]; then
  /opt/homebrew/bin/timeout 300s /opt/homebrew/bin/node scripts/record-venue-flows.mjs --chunk 2000 || echo "venue-flows:database failed or timed out (non-fatal)"
else
  recorder_stage_skip venue_flow_database local_storage_selected
fi
# Continue the separately bootstrapped local receipt chains even while Neon is
# quota-limited. Their first block is explicit; gaps remain unsealed.
recorder_stage_run venue_flow_local /opt/homebrew/bin/timeout 300s /opt/homebrew/bin/node scripts/record-venue-flows.mjs --local --chunk 200 || echo "venue-flows:local failed or timed out (non-fatal)"
# Exact configured secondary-exit routes: PSM/Curve swaps plus pinned output
# inventory endpoints. Separate local receipts; no future-flow claim.
recorder_stage_run route_flow_local /opt/homebrew/bin/timeout 300s /opt/homebrew/bin/node scripts/record-route-flows.mjs --capture --chunk 200 || echo "route-flows:local failed or timed out (non-fatal)"
# Bounded retrospective inventory grid for the three undercovered venue exits.
# This cannot fill a missed prospective observation or prove future holder exit.
recorder_stage_run three_venue_history /opt/homebrew/bin/timeout 300s /opt/homebrew/bin/node scripts/record-historical-three-venue-inventory.mjs --capture --batch 32 || echo "three-venue-history:capture failed or timed out (non-fatal)"
# Preserve future $1m crvUSD→USDT/USDC nominal quotes for a genuinely later
# forecast evaluation. The collector reads one finalized block, stops below its
# 1 GiB disk reserve, and never replaces a completed checkpoint. Missed ticks
# remain missing observations rather than quiet outcomes.
recorder_stage_run quote /opt/homebrew/bin/node scripts/research/curve-prospective-quote.mjs --run || echo "curve-quote:record failed (non-fatal)"
/opt/homebrew/bin/node scripts/research/curve-prospective-quote.mjs --verify || echo "curve-quote:verify failed (non-fatal)"
# Freeze the vault's exact proxy target and target-code identity at this quote
# checkpoint. A missing or stale source remains unavailable; this is research
# comparability evidence, not an exit alert.
/opt/homebrew/bin/node scripts/research/scrvusd-target-code-attestation.mjs --run || echo "scrvusd-target-code:record failed (non-fatal)"
/opt/homebrew/bin/node scripts/research/scrvusd-target-code-attestation.mjs --verify || echo "scrvusd-target-code:verify failed (non-fatal)"
# Observe the same predeclared holder and raw exit size at each new sealed
# quote block. This is local research only: an eth_call result is not a live
# withdrawal, and a missed or ambiguous checkpoint remains missing evidence.
if [ -f data/research/venue-signals/scrvusd-fixed-holder-exit/plan.json ]; then
  if /opt/homebrew/bin/node scripts/research/scrvusd-holder-selection-link.mjs --verify; then
    recorder_stage_run holder_observe /opt/homebrew/bin/node scripts/research/scrvusd-fixed-holder-exit.mjs --observe --rpc-index 1 || echo "scrvusd-holder-exit:observe failed (non-fatal)"
  else
    recorder_stage_skip holder_observe selection_verification_failed
    echo "scrvusd-holder-exit:selection verification failed; observation skipped (non-fatal)"
  fi
  /opt/homebrew/bin/node scripts/research/scrvusd-fixed-holder-exit.mjs --verify || echo "scrvusd-holder-exit:verify failed (non-fatal)"
else
  recorder_stage_skip holder_observe plan_absent
fi
# Issue the separate level-only quote forecast promptly: its quote-age cap is
# two hours, and the later archive flow scans may consume that window.
/opt/homebrew/bin/node scripts/research/curve-prospective-level-forecast.mjs --issue || echo "curve-level-forecast:issue failed (non-fatal)"
# These nominal quote duration/forecast issuers share the same two-hour quote
# age cap. Enroll before bounded archive scans; matured scoring stays later.
/opt/homebrew/bin/node scripts/research/curve-prospective-duration.mjs --run || echo "curve-duration:issue failed (non-fatal)"
/opt/homebrew/bin/node scripts/research/curve-prospective-forecast.mjs --run || echo "curve-forecast:issue failed (non-fatal)"
# Issue the NOW-origin holder risk set immediately after same-block capture.
# The companion binds only previously sealed flow context known at issue time;
# optional fresh flow scans follow, and absent context stays unavailable.
if [ -f data/research/venue-signals/scrvusd-fixed-holder-exit/plan.json ]; then
  recorder_stage_run holder_duration_issue /opt/homebrew/bin/node scripts/research/scrvusd-holder-duration.mjs --run || echo "scrvusd-holder-duration:issue failed (non-fatal)"
  /opt/homebrew/bin/node scripts/research/scrvusd-holder-flow-context.mjs --run || echo "scrvusd-holder-flow-context:issue failed (non-fatal)"
  /opt/homebrew/bin/node scripts/research/scrvusd-holder-flow-context.mjs --verify || echo "scrvusd-holder-flow-context:verify failed (non-fatal)"
  # Caller-horizon NOW-origin research receipts require a fresh same-block
  # holder probe; future forecast status abstains without calibration.
  recorder_stage_run now_1h_issue /opt/homebrew/bin/node scripts/research/scrvusd-exit-forecast-issue.mjs --issue 3600 || echo "scrvusd-exit-forecast:1h issue failed (non-fatal)"
  recorder_stage_run now_2h_issue /opt/homebrew/bin/node scripts/research/scrvusd-exit-forecast-issue.mjs --issue 7200 || echo "scrvusd-exit-forecast:2h issue failed (non-fatal)"
  recorder_stage_run now_24h_issue /opt/homebrew/bin/node scripts/research/scrvusd-exit-forecast-issue.mjs --issue 86400 || echo "scrvusd-exit-forecast:24h issue failed (non-fatal)"
  recorder_stage_run now_7d_issue /opt/homebrew/bin/node scripts/research/scrvusd-exit-forecast-issue.mjs --issue 604800 || echo "scrvusd-exit-forecast:7d issue failed (non-fatal)"
  /opt/homebrew/bin/node scripts/research/scrvusd-exit-forecast-issue.mjs --verify || echo "scrvusd-exit-forecast:verify failed (non-fatal)"
else
  recorder_stage_skip holder_duration_issue plan_absent
  recorder_stage_skip now_1h_issue plan_absent
  recorder_stage_skip now_2h_issue plan_absent
  recorder_stage_skip now_24h_issue plan_absent
  recorder_stage_skip now_7d_issue plan_absent
fi
# Seal the vault Deposit/Withdraw frontier at the latest verified quote block,
# including quiet blocks. A partial bounded catch-up or block-hash disagreement
# fails closed; no moving-head flow window is treated as aligned evidence.
# Freeze as-of vault event features only after the exact-B scan verifies.
# This work follows fresh issuance: a later feature cannot be backfilled into
# an earlier holder issue; missing 24h/7d context remains unavailable.
flow_quote_aligned=false
flow_scan_ok=false
if /opt/homebrew/bin/node scripts/research/curve-vault-flow-ledger.mjs --run --to-latest-quote --rpc-index 1 --max-chunks 4; then
  flow_scan_ok=true
else
  # The exact-B collector resumes from sealed receipts after a transient RPC
  # failure. Give the archive host one bounded retry before skipping feature issuance.
  sleep 20
  if /opt/homebrew/bin/node scripts/research/curve-vault-flow-ledger.mjs --run --to-latest-quote --rpc-index 1 --max-chunks 4; then
    flow_scan_ok=true
  fi
fi
# The second configured archive host accepts six-block log ranges. If the
# primary host remains unavailable, two bounded paced passes can advance the
# same hash-chained frontier; an incomplete catch-up still fails alignment.
if [ "$flow_scan_ok" = false ]; then
  for flow_fallback_pass in 1 2; do
    if /opt/homebrew/bin/node scripts/research/curve-vault-flow-ledger.mjs --run --to-latest-quote --rpc-index 0 --max-chunks 32 --range 6 --pace-ms 500; then
      flow_scan_ok=true
      break
    fi
  done
fi
if [ "$flow_scan_ok" = true ] && \
   /opt/homebrew/bin/node scripts/research/curve-vault-flow-ledger.mjs --verify --to-latest-quote; then
  flow_quote_aligned=true
  /opt/homebrew/bin/node scripts/research/curve-vault-flow-feature-issues.mjs --run || echo "curve-vault-flow:feature issue failed (non-fatal)"
  /opt/homebrew/bin/node scripts/research/curve-vault-flow-feature-issues.mjs --verify || echo "curve-vault-flow:feature verify failed (non-fatal)"
else
  echo "curve-vault-flow:quote alignment failed; feature issue skipped (non-fatal)"
fi
# Advance the frozen near-live suffix for later issues; this tick's already
# issued companion cannot acquire evidence collected after its cutoff.
# The offline verifier checks every receipt boundary witness.
/opt/homebrew/bin/node scripts/research/curve-vault-flow-near-live.mjs --run --max-chunks 8 --pace-ms 1000 --rpc-index 1 || echo "curve-vault-flow:near-live failed (non-fatal)"
/opt/homebrew/bin/node scripts/research/curve-vault-flow-near-live.mjs --verify || echo "curve-vault-flow:near-live verify failed (non-fatal)"
# Cohort and other research lanes follow the fresh fixed-holder issue path.
# Sample every preregistered holder/size pair at the earliest later finalized
# quote checkpoint. The observer refuses to skip a missing or stale earlier
# checkpoint; read-only calls here are research evidence, not exit alerts.
if [ -f data/research/venue-signals/scrvusd-cohort-plan/plan.json ]; then
  if /opt/homebrew/bin/node scripts/research/scrvusd-cohort-plan.mjs --verify; then
    /opt/homebrew/bin/node scripts/research/scrvusd-cohort-observe.mjs --run --rpc-index 0 || echo "scrvusd-cohort:observe failed (non-fatal)"
  else
    echo "scrvusd-cohort:plan verification failed; observation skipped (non-fatal)"
  fi
  /opt/homebrew/bin/node scripts/research/scrvusd-cohort-observe.mjs --verify || echo "scrvusd-cohort:verify failed (non-fatal)"
fi
# Freeze the full cohort risk set after attempting exact-B flow alignment, so a
# successful same-block feature can be known before issue time. A flow failure
# still permits a holder-only duration issue; missing context stays explicit.
if [ -f data/research/venue-signals/scrvusd-cohort-plan/plan.json ]; then
  /opt/homebrew/bin/node scripts/research/scrvusd-cohort-duration.mjs --run || echo "scrvusd-cohort-duration:issue failed (non-fatal)"
  /opt/homebrew/bin/node scripts/research/scrvusd-cohort-duration.mjs --score || echo "scrvusd-cohort-duration:score failed (non-fatal)"
  /opt/homebrew/bin/node scripts/research/scrvusd-cohort-duration.mjs --verify || echo "scrvusd-cohort-duration:verify failed (non-fatal)"
  # Preserve which exact-B vault-flow feature was known at cohort issue time.
  # Late same-block flow remains explicitly unavailable in the companion.
  /opt/homebrew/bin/node scripts/research/scrvusd-cohort-flow-context.mjs --run || echo "scrvusd-cohort-flow-context:issue failed (non-fatal)"
  /opt/homebrew/bin/node scripts/research/scrvusd-cohort-flow-context.mjs --verify || echo "scrvusd-cohort-flow-context:verify failed (non-fatal)"
fi
# Separate sUSDS/USDS direct-vault cohort: source and implementation identity
# checkpoints and a prospectively selected fixed-holder exit simulation.
# Never align these checkpoints to the scrvUSD Curve quote series.
/opt/homebrew/bin/node scripts/research/susds-finalized-checkpoint.mjs --run || echo "susds-checkpoint:record failed (non-fatal)"
/opt/homebrew/bin/node scripts/research/susds-finalized-checkpoint.mjs --verify || echo "susds-checkpoint:verify failed (non-fatal)"
if [ -f data/research/venue-signals/susds-holder-plan/plan.json ]; then
  if /opt/homebrew/bin/node scripts/research/susds-holder-plan.mjs --verify; then
    /opt/homebrew/bin/node scripts/research/susds-fixed-holder-exit.mjs --run --rpc-index 1 || echo "susds-holder-exit:observe failed (non-fatal)"
  else
    echo "susds-holder-exit:plan verification failed; observation skipped (non-fatal)"
  fi
  /opt/homebrew/bin/node scripts/research/susds-fixed-holder-exit.mjs --verify || echo "susds-holder-exit:verify failed (non-fatal)"
  /opt/homebrew/bin/node scripts/research/susds-holder-duration.mjs --run || echo "susds-holder-duration:issue failed (non-fatal)"
  /opt/homebrew/bin/node scripts/research/susds-holder-duration.mjs --score || echo "susds-holder-duration:score failed (non-fatal)"
  /opt/homebrew/bin/node scripts/research/susds-holder-duration.mjs --verify || echo "susds-holder-duration:verify failed (non-fatal)"
fi
# Keep the separate sUSDS Deposit/Withdraw scan behind the scrvUSD archive
# attempt on their shared RPC host. Gross/net event flow is historical context.
if [ -f data/research/venue-signals/susds-vault-flow-ledger/plan.json ]; then
  /opt/homebrew/bin/node scripts/research/susds-vault-flow-ledger.mjs --run --rpc-index 1 --range 64 --max-chunks 6 || echo "susds-flow:record failed (non-fatal)"
  /opt/homebrew/bin/node scripts/research/susds-vault-flow-ledger.mjs --verify || echo "susds-flow:verify failed (non-fatal)"
fi
# Once the suffix reaches the frozen live boundary, seal joined features at
# the latest exact-B quote. Until then, --run-if-ready reports waiting.
if [ "$flow_quote_aligned" = true ]; then
  /opt/homebrew/bin/node scripts/research/curve-vault-flow-composite-feature-issues.mjs --run-if-ready || echo "curve-vault-flow:composite feature issue failed (non-fatal)"
fi
# Read-only same-holder trend follows the new issues; it cannot delay their
# fresh quote/holder enrollment and never sends a forward warning.
if [ -f data/research/venue-signals/scrvusd-fixed-holder-exit/plan.json ]; then
  /opt/homebrew/bin/node scripts/research/scrvusd-holder-exit-trend.mjs || echo "scrvusd-holder-exit:trend failed (non-fatal)"
fi
# Score matured holder outcomes after fresh same-block issues are attempted.
if [ -f data/research/venue-signals/scrvusd-fixed-holder-exit/plan.json ]; then
  /opt/homebrew/bin/node scripts/research/scrvusd-holder-duration.mjs --score || echo "scrvusd-holder-duration:score failed (non-fatal)"
  /opt/homebrew/bin/node scripts/research/scrvusd-holder-duration.mjs --verify || echo "scrvusd-holder-duration:verify failed (non-fatal)"
  /opt/homebrew/bin/node scripts/research/scrvusd-exit-forecast-score.mjs --score || echo "scrvusd-exit-forecast:score failed (non-fatal)"
  /opt/homebrew/bin/node scripts/research/scrvusd-exit-forecast-score.mjs --verify || echo "scrvusd-exit-forecast:score verify failed (non-fatal)"
fi
# Score matured level-only endpoints after fresh direct-exit issues are attempted.
# Historical analog outcomes were filtered at issue time; no alert is sent.
/opt/homebrew/bin/node scripts/research/curve-prospective-level-forecast.mjs --score || echo "curve-level-forecast:score failed (non-fatal)"
/opt/homebrew/bin/node scripts/research/curve-prospective-level-forecast.mjs --verify || echo "curve-level-forecast:verify failed (non-fatal)"
# Research-only measured change in the same $1m quote over adjacent sealed
# checkpoints. This prints a status; it does not send an alert or forecast.
/opt/homebrew/bin/node scripts/research/curve-quote-shrinkage-watch.mjs || echo "curve-quote:shrinkage-watch failed (non-fatal)"
# Score matured first-breach nominal quote conditions, censoring missing grids.
/opt/homebrew/bin/node scripts/research/curve-prospective-duration.mjs --score || echo "curve-duration:score failed (non-fatal)"
# Score matured 24h/7d nominal quote forecasts with continuous coverage.
/opt/homebrew/bin/node scripts/research/curve-prospective-forecast.mjs --score || echo "curve-forecast:score failed (non-fatal)"
# Bounded transaction-class reconciliation for NEW Curve depth events. Never
# blocks the next capacity tick if an archive RPC is unavailable.
/opt/homebrew/bin/node scripts/record-venue-event-drivers.mjs --limit 8 || echo "drivers:reconcile failed (non-fatal)"
# Venue news last (external RSS; upsert-idempotent). Non-fatal — a Google News
# hiccup must never fail the capacity/flows tick, so swallow its exit code.
/opt/homebrew/bin/node scripts/fetch-venue-news.mjs || echo "news:fetch failed (non-fatal)"
# Each configured RSS attempt now leaves a sealed per-venue receipt. Failed,
# capped, and absent polls cannot establish a feed-quiet comparison window.
/opt/homebrew/bin/node scripts/lib/newsPollLedger.mjs --verify || echo "news:poll-receipts verify failed (non-fatal)"
# Preserve local first-seen times for prospective signal research. This reads
# the saved news rows and appends only unseen raw observations; no alert sends.
/opt/homebrew/bin/node scripts/research/venue-news-event-ledger.mjs --from-db || echo "news:research-ledger failed (non-fatal)"
/opt/homebrew/bin/node scripts/research/venue-news-event-ledger.mjs --verify || echo "news:research-verify failed (non-fatal)"
# Enroll only locally first-seen incidents after the sealed research arm. This
# records nominal quote-study targets; it does not issue user-facing alerts.
if [ -f data/research/venue-signals/curve-news-enrollment/000000000001.json ]; then
  if /opt/homebrew/bin/node scripts/research/curve-news-prospective-enrollment.mjs --run; then
    # Refresh the pre-event baseline only after every currently saved incident
    # has been assessed. The issuer skips a redundant arm if no new quote exists.
    if /opt/homebrew/bin/node scripts/research/curve-news-prospective-enrollment.mjs --arm; then
      # Freeze a feed-quiet candidate immediately after its pre-event quote arm.
      # It remains unscorable without later complete poll and quote coverage.
      /opt/homebrew/bin/node scripts/research/curve-news-quiet-controls.mjs --issue || echo "news:quiet-issue failed (non-fatal)"
    else
      echo "news:prospective-rearm failed; quiet issue skipped (non-fatal)"
    fi
  else
    echo "news:prospective-enrollment failed; rearm skipped (non-fatal)"
  fi
  /opt/homebrew/bin/node scripts/research/curve-news-prospective-enrollment.mjs --verify || echo "news:prospective-verify failed (non-fatal)"
  /opt/homebrew/bin/node scripts/research/curve-news-quiet-controls.mjs --score || echo "news:quiet-score failed (non-fatal)"
  /opt/homebrew/bin/node scripts/research/curve-news-quiet-controls.mjs --verify || echo "news:quiet-verify failed (non-fatal)"
fi
# Refresh tracked strat positions (batched multicall reads; the /strats board
# serves this cache + freshness stamp). Non-fatal.
/opt/homebrew/bin/node scripts/refresh-strat-positions.mjs || echo "strats:refresh failed (non-fatal)"
# Exact GHO→sGHO rate leg and fixed-August-cohort holder stock. The script
# skips each successfully measured leg until 24h has elapsed; failed legs can
# retry at the next hourly tick. Old successful readings remain displayable.
# Extend only finalized, contiguous GHO/sGHO event coverage with two distinct
# RPC hosts agreeing on all three log streams. At most four chunks per tick;
# this is an event-observed sample, never a borrower census or route TVL.
/opt/homebrew/bin/node scripts/route-cohort/prospective-entrants.mjs --run --from-block 26069513 --max-chunks 4 || echo "carry-entrants:scan failed (non-fatal)"
/opt/homebrew/bin/node scripts/route-cohort/prospective-entrants.mjs --verify --from-block 26069513 || echo "carry-entrants:verify failed (non-fatal)"
/opt/homebrew/bin/node scripts/record-carry-routes.mjs || echo "carry-routes:refresh failed (non-fatal)"
# Independent Aave USDe→sUSDe pilot. Each successful aggregate, all-depositor
# vault-assets, and exact rate leg refreshes from its source time after 24h;
# hashed local artifacts are verified before aggregate-only Neon writes.
/opt/homebrew/bin/node scripts/record-usde-carry-pilot.mjs --run || echo "usde-carry:refresh failed (non-fatal)"
# Separate USDe/sUSDe event frontier, begun prospectively at the first finalized
# block after the Sep 27 18:05:11 UTC observation. Logs are local-only candidate
# evidence, not a current borrower census or route TVL. Never skip gaps.
/opt/homebrew/bin/node scripts/route-cohort/usde-prospective-entrants.mjs --run --from-block 26070465 --max-chunks 4 || echo "usde-entrants:scan failed (non-fatal)"
/opt/homebrew/bin/node scripts/route-cohort/usde-prospective-entrants.mjs --verify --from-block 26070465 || echo "usde-entrants:verify failed (non-fatal)"
# Score any due CALLED-IT receipts against the snapshots we just refreshed (no
# chain reads). Non-fatal — a scoring hiccup must never fail the capacity tick.
/opt/homebrew/bin/node scripts/score-user-receipts.mjs || echo "receipts:score failed (non-fatal)"
# The older, distant historical lane remains last. A 429 leaves its previous
# sealed frontier intact. Full v2 issue replay is a separate offline audit.
/opt/homebrew/bin/node scripts/research/curve-vault-flow-ledger.mjs --run --historical --rpc-index 1 --max-chunks 4 --pace-ms 1000 || echo "curve-vault-flow:historical failed (non-fatal)"
/opt/homebrew/bin/node scripts/research/curve-vault-flow-ledger.mjs --historical --verify || echo "curve-vault-flow:historical verify failed (non-fatal)"
