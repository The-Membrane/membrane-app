#!/bin/sh
# Finalized cash capture, exact-holder exit labels, model issue/score, and
# exact-subject coverage check.
# Keep independent stages running after a failure, but surface any failure to
# launchd with a nonzero final exit. Missed slots are never backfilled.
script_path=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
if [ "${1-}" != '--locked' ]; then
  # Share the exact-holder ledger lock with the five-minute score-only job.
  # A missed full tick is visible as a failure instead of running concurrently.
  exec /usr/bin/python3 - "$script_path" <<'PY'
import fcntl
import os
import sys

path = os.path.join(os.environ.get('TMPDIR') or '/private/tmp', 'membrane-carry-exit-ledgers.lock')
fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    print('carry-cash-observation:exit-ledger-lock-busy', file=sys.stderr, flush=True)
    sys.exit(1)
os.set_inheritable(fd, True)
os.execv('/bin/sh', ['/bin/sh', sys.argv[1], '--locked'])
PY
fi

cd "$(dirname "$0")/.." || exit 1
echo "=== carry cash observation tick $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

failed=0
run_stage() {
  stage=$1
  shift
  if "$@"; then
    echo "carry-cash-observation:$stage ok"
  else
    status=$?
    echo "carry-cash-observation:$stage failed (exit $status)" >&2
    failed=$((failed + 1))
  fi
}

# Score the already frozen holder/amount scenario before issuing this slot's
# new scenarios. These measurements are separate from the cash forecasts.
run_stage morpho-exit-score /opt/homebrew/bin/timeout 180s /opt/homebrew/bin/node --import tsx scripts/record-carry-morpho-exit-outcomes.mjs --score
run_stage morpho-exit-issue /opt/homebrew/bin/timeout 180s /opt/homebrew/bin/node --import tsx scripts/record-carry-morpho-exit-outcomes.mjs --issue
run_stage morpho-exit-audit /opt/homebrew/bin/timeout 60s /opt/homebrew/bin/node --import tsx scripts/record-carry-morpho-exit-outcomes.mjs --audit

run_stage direct-exit-score /opt/homebrew/bin/timeout 180s /opt/homebrew/bin/node --import tsx scripts/record-carry-direct-exit-outcomes.mjs --score
run_stage direct-exit-issue /opt/homebrew/bin/timeout 180s /opt/homebrew/bin/node --import tsx scripts/record-carry-direct-exit-outcomes.mjs --issue
run_stage direct-exit-audit /opt/homebrew/bin/timeout 60s /opt/homebrew/bin/node --import tsx scripts/record-carry-direct-exit-outcomes.mjs --audit

run_stage susds-exit-score /opt/homebrew/bin/timeout 180s /opt/homebrew/bin/node --import tsx scripts/record-carry-susds-exit-outcomes.mjs --score
run_stage susds-exit-issue /opt/homebrew/bin/timeout 180s /opt/homebrew/bin/node --import tsx scripts/record-carry-susds-exit-outcomes.mjs --issue
run_stage susds-exit-audit /opt/homebrew/bin/timeout 60s /opt/homebrew/bin/node --import tsx scripts/record-carry-susds-exit-outcomes.mjs --audit

# USD3 exact-holder evidence has its own local issue/score schedule.

run_stage vault /opt/homebrew/bin/timeout 120s /opt/homebrew/bin/node scripts/record-carry-route-vaults.mjs
run_stage direct /opt/homebrew/bin/timeout 120s /opt/homebrew/bin/node --import tsx scripts/record-carry-direct-supply.mjs
run_stage spark /opt/homebrew/bin/timeout 120s /opt/homebrew/bin/node --import tsx scripts/record-carry-direct-supply.mjs --spark
run_stage twyne-pt-reserve /opt/homebrew/bin/timeout 120s /opt/homebrew/bin/node --import tsx scripts/record-twyne-pt-reserve.mjs
run_stage issue /opt/homebrew/bin/timeout 120s /opt/homebrew/bin/node scripts/record-carry-cash-issues.mjs --issue
run_stage model-issue /opt/homebrew/bin/timeout 120s /opt/homebrew/bin/node --import tsx scripts/record-carry-cash-model.mjs --issue
run_stage twyne-pt-model-issue /opt/homebrew/bin/timeout 120s /opt/homebrew/bin/node --import tsx scripts/record-twyne-pt-model.mjs --issue
run_stage score /opt/homebrew/bin/timeout 120s /opt/homebrew/bin/node scripts/record-carry-cash-issues.mjs --score
run_stage model-score /opt/homebrew/bin/timeout 120s /opt/homebrew/bin/node --import tsx scripts/record-carry-cash-model.mjs --score
run_stage twyne-pt-model-score /opt/homebrew/bin/timeout 120s /opt/homebrew/bin/node --import tsx scripts/record-twyne-pt-model.mjs --score
run_stage audit /opt/homebrew/bin/timeout 120s /opt/homebrew/bin/node scripts/audit-carry-cash-issue-scores.mjs
run_stage twyne-pt-model-audit /opt/homebrew/bin/timeout 120s /opt/homebrew/bin/node --import tsx scripts/audit-twyne-pt-model.mjs
run_stage forecast-coverage /opt/homebrew/bin/timeout 120s /opt/homebrew/bin/node scripts/audit-carry-forecast-coverage.mjs

if [ "$failed" -ne 0 ]; then
  echo "carry-cash-observation:tick failed ($failed stage failures)" >&2
  exit 1
fi
echo 'carry-cash-observation:tick ok'
