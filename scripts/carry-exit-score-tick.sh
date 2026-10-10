#!/bin/sh
# Score frozen exact-holder exit issues between the full cash/exit ticks.
# The launchd job imposes a 240s total deadline so a regular run finishes
# before the next :10/:25/:40/:55 full tick. No issue or model stage runs here.
set -u

script_path=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
if [ "${1-}" != '--locked' ]; then
  # Keep the lock inherited across the Python -> shell exec. A killed job
  # releases the lock automatically; no stale directory needs cleanup.
  exec /usr/bin/python3 - "$script_path" <<'PY'
import fcntl
import os
import sys

path = os.path.join(os.environ.get('TMPDIR') or '/private/tmp', 'membrane-carry-exit-ledgers.lock')
fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    print('carry-exit-score:already-running', flush=True)
    sys.exit(0)
os.set_inheritable(fd, True)
os.execv('/bin/sh', ['/bin/sh', sys.argv[1], '--locked'])
PY
fi

cd "$(dirname "$0")/.." || exit 1
echo "=== carry exit score tick $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

launchctl_bin=${CARRY_EXIT_SCORE_LAUNCHCTL_BIN:-/bin/launchctl}
main_job="gui/$(id -u)/com.membrane.carry-cash-observations"
if main_state=$("$launchctl_bin" print "$main_job" 2>/dev/null); then
  if printf '%s\n' "$main_state" | /usr/bin/grep -Eq '^[[:space:]]*state = running[[:space:]]*$'; then
    echo 'carry-exit-score:main-tick-running; skip'
    exit 0
  fi
else
  echo 'carry-exit-score:cannot verify main tick state' >&2
  exit 1
fi

node_bin=${CARRY_EXIT_SCORE_NODE_BIN:-/opt/homebrew/bin/node}
timeout_bin=${CARRY_EXIT_SCORE_TIMEOUT_BIN:-/opt/homebrew/bin/timeout}
failed=0
run_stage() {
  stage=$1
  shift
  if "$timeout_bin" -k 5s 50s "$node_bin" --import tsx "$@" --score; then
    echo "carry-exit-score:$stage ok"
  else
    status=$?
    echo "carry-exit-score:$stage failed (exit $status)" >&2
    failed=$((failed + 1))
  fi
}

run_stage morpho scripts/record-carry-morpho-exit-outcomes.mjs
run_stage direct scripts/record-carry-direct-exit-outcomes.mjs
run_stage susds scripts/record-carry-susds-exit-outcomes.mjs
run_stage usd3 scripts/record-carry-usd3-exit-outcomes.mjs

if [ "$failed" -ne 0 ]; then
  echo "carry-exit-score:tick failed ($failed stage failures)" >&2
  exit 1
fi
echo 'carry-exit-score:tick ok'
