#!/bin/sh
# Standalone, bounded local prospective cash capture and baseline ledger.
# Existing hourly venue-recorder stages remain as a redundant source; both
# receipt and issue appenders are idempotent at their source/UTC-hour keys.
script_path=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
if [ "${1-}" != '--locked' ]; then
  exec /usr/bin/python3 - "$script_path" "${1-}" <<'PY'
import fcntl
import os
import sys

path = os.path.join(os.environ.get('TMPDIR') or '/private/tmp', 'membrane-carry-local-cash-tick.lock')
fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    print('carry-local-cash:tick-lock-busy', file=sys.stderr, flush=True)
    sys.exit(1)
os.set_inheritable(fd, True)
os.execv('/bin/sh', ['/bin/sh', sys.argv[1], '--locked', sys.argv[2]])
PY
fi

cd "$(dirname "$0")/.." || exit 1
if ! /usr/bin/python3 - <<'PY'
import os
import sys

stat = os.statvfs('data/research/venue-signals')
if stat.f_bavail * stat.f_frsize < 1024 * 1024 * 1024:
    print('carry-local-cash:disk-reserve', file=sys.stderr)
    sys.exit(1)
PY
then
  exit 1
fi

# Read-only operational check. It does not collect or issue data.
if [ "${2-}" = '--preflight' ]; then
  echo 'carry-local-cash:preflight-ok'
  exit 0
fi
if [ -n "${2-}" ]; then
  echo 'carry-local-cash:unknown-option' >&2
  exit 2
fi

capture_file=$(/usr/bin/mktemp "${TMPDIR:-/private/tmp}/carry-local-cash.XXXXXXXX") || exit 1
trap 'rm -f "$capture_file"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
echo "=== carry local cash tick $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
failed=0
fresh_capture=0
node_bin=${CARRY_CASH_NODE_BIN:-/opt/homebrew/bin/node}
timeout_bin=${CARRY_CASH_TIMEOUT_BIN:-/opt/homebrew/bin/timeout}
run_stage() {
  "$timeout_bin" -k 5s "$1" "$node_bin" --max-old-space-size=384 --import tsx "$2" "$3"
}

# Exact-Q holder-exit forecasts run before cash capture under the same lock.
# Each stage is independent: a missed issue never prevents maturity scoring.
if [ "${CARRY_CASH_EXIT_V2_ENABLED:-0}" = 1 ]; then
  if run_stage 90s scripts/research/carry-local-exit-v2-no-neon-issue.mjs --tick; then
    echo 'carry-local-cash:exit-v2-issue-ok'
  else
    echo 'carry-local-cash:exit-v2-issue-failed' >&2
    failed=1
  fi
  if run_stage 120s scripts/research/carry-local-exit-v2-tick.mjs --tick; then
    echo 'carry-local-cash:exit-v2-score-ok'
  else
    echo 'carry-local-cash:exit-v2-score-failed' >&2
    failed=1
  fi
else
  echo 'carry-local-cash:exit-v2-disabled'
fi

if run_stage 180s scripts/record-carry-cash-local.mjs --current > "$capture_file"; then
  if [ ! -s "$capture_file" ]; then
    echo 'carry-local-cash:capture-output-missing' >&2
    failed=1
  else
    cat "$capture_file"
  fi
  if [ -s "$capture_file" ] && "$node_bin" scripts/lib/carryLocalCashTickGate.mjs "$capture_file"; then
    fresh_capture=1
  fi
else
  echo 'carry-local-cash:capture-failed' >&2
  failed=1
fi

if run_stage 180s scripts/record-supplemental-aave-usde-cash-local.mjs --current; then
  echo 'carry-local-cash:supplemental-capture-ok'
else
  echo 'carry-local-cash:supplemental-capture-failed' >&2
  failed=1
fi

# Freeze model enrollment before creating the first eligible baseline issue.
# Registration is idempotent after activation.
model_ready=0
if run_stage 180s scripts/record-carry-cash-local-model.mjs --register; then
  echo 'carry-local-cash:model-register-ok'
  model_ready=1
else
  echo 'carry-local-cash:model-register-failed' >&2
  failed=1
fi

if [ "$fresh_capture" -eq 1 ] && [ "$model_ready" -eq 1 ]; then
  if run_stage 90s scripts/record-carry-cash-local-issues.mjs --issue; then
    echo 'carry-local-cash:issue-ok'
  else
    echo 'carry-local-cash:issue-failed' >&2
    failed=1
  fi
else
  echo 'carry-local-cash:issue-skipped-no-new-fresh-capture-or-model-enrollment'
fi

# This writes one immutable hourly opportunity even when the baseline source
# was missed, so recorder outages remain in the validation denominator.
if [ "$model_ready" -eq 1 ]; then
  if run_stage 120s scripts/record-carry-cash-local-model.mjs --issue; then
    echo 'carry-local-cash:model-issue-ok'
  else
    echo 'carry-local-cash:model-issue-failed' >&2
    failed=1
  fi
fi

# Prior issues mature independently; capture failure never creates a new issue.
if run_stage 90s scripts/record-carry-cash-local-issues.mjs --score; then
  echo 'carry-local-cash:score-ok'
else
  echo 'carry-local-cash:score-failed' >&2
  failed=1
fi

if [ "$model_ready" -eq 1 ]; then
  if run_stage 120s scripts/record-carry-cash-local-model.mjs --score; then
    echo 'carry-local-cash:model-score-ok'
  else
    echo 'carry-local-cash:model-score-failed' >&2
    failed=1
  fi
fi

if [ "${CARRY_CASH_V2_ENABLED:-0}" = 1 ]; then
  # The complete legacy chain stays ahead of optional V2 work so V2 timeouts
  # cannot starve capture, issue, or score stages. Mature V2 issues score first
  # within this optional tail, once per enabled wrapper invocation.
  # Enrollment is bootstrapped and verified once before this flag is enabled;
  # the recurring wrapper never registers or changes either cohort cutoff.
  if run_stage 120s scripts/record-carry-cash-prospective-v2.mjs --score; then
    echo 'carry-local-cash:two-score-ok'
  else
    echo 'carry-local-cash:two-score-failed' >&2
    failed=1
  fi
  if run_stage 120s scripts/record-carry-cash-vault5-v2.mjs --score; then
    echo 'carry-local-cash:vault5-score-ok'
  else
    echo 'carry-local-cash:vault5-score-failed' >&2
    failed=1
  fi

  if run_stage 120s scripts/record-carry-cash-prospective-v2.mjs --tick; then
    echo 'carry-local-cash:two-tick-ok'
  else
    echo 'carry-local-cash:two-tick-failed' >&2
    failed=1
  fi
  if run_stage 120s scripts/record-carry-cash-vault5-v2.mjs --tick; then
    echo 'carry-local-cash:vault5-tick-ok'
  else
    echo 'carry-local-cash:vault5-tick-failed' >&2
    failed=1
  fi
else
  echo 'carry-local-cash:v2-disabled'
fi
exit "$failed"
