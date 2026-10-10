#!/bin/sh
# New finalized receipt mints and their holder proofs share one serial campaign lock.
set -eu
cd "$(dirname "$0")/.."
status=0
/opt/homebrew/bin/node --max-old-space-size=384 \
  scripts/research/apyusd-prospective-receipt-intake.mjs --capture || status=$((status | 1))
/opt/homebrew/bin/node --max-old-space-size=384 \
  scripts/research/apyusd-prospective-receipt-forceability.mjs --capture || status=$((status | 2))
/opt/homebrew/bin/node --max-old-space-size=384 \
  scripts/research/apyusd-prospective-impairment-followup.mjs --capture || status=$((status | 4))
/opt/homebrew/bin/node --max-old-space-size=384 \
  scripts/research/apyusd-prospective-receipt-outcomes.mjs --capture || status=$((status | 8))
if [ "$status" -eq 0 ]; then
  exit 0
fi
# 65–79 identify completed stage runs; setup failures keep their native exit code.
exit "$((64 + status))"
