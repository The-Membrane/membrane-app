#!/bin/sh
# Separate bounded Morpho flow and receipt tick. The H1 cash/exit job has its
# own launchd label and never waits on these stages.
set -u

script_path=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
if [ "${1-}" != '--locked' ]; then
  # An inherited advisory lock survives the Python -> shell exec and is
  # released automatically on exit or SIGKILL. No stale mkdir lock remains.
  exec /usr/bin/python3 - "$script_path" <<'PY'
import fcntl
import os
import sys

path = os.path.join(os.environ.get('TMPDIR') or '/private/tmp', 'membrane-carry-morpho-flow.lock')
fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    print('carry-morpho-flow:already-running', flush=True)
    sys.exit(0)
os.set_inheritable(fd, True)
os.execv('/bin/sh', ['/bin/sh', sys.argv[1], '--locked'])
PY
fi

cd "$(dirname "$0")/.." || exit 1
echo "=== carry morpho flow tick $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

node_bin=${MORPHO_NODE_BIN:-/opt/homebrew/bin/node}
timeout_bin=${MORPHO_TIMEOUT_BIN:-/opt/homebrew/bin/timeout}
failed=0
run_stage() {
  stage=$1
  shift
  if "$@"; then
    echo "carry-morpho-flow:$stage ok"
  else
    status=$?
    echo "carry-morpho-flow:$stage failed (exit $status)" >&2
    failed=$((failed + 1))
  fi
}

# Capture has an internal 240-second deadline; GNU timeout enforces a hard
# bound if the RPC stalls. Reconciliation has its own bounded local pass.
# Continue to reconciliation after a capture failure to process sealed backlog.
run_stage capture "$timeout_bin" -k 10s 250s "$node_bin" scripts/record-carry-morpho-v2-flows-local.mjs --capture
run_stage reconcile "$timeout_bin" -k 10s 205s "$node_bin" scripts/reconcile-carry-morpho-v2-withdrawals-local.mjs --run

if [ "$failed" -ne 0 ]; then
  echo "carry-morpho-flow:tick failed ($failed stage failures)" >&2
  exit 1
fi
echo 'carry-morpho-flow:tick ok'
