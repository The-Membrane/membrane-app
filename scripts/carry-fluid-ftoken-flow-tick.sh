#!/bin/sh
# Bounded prospective gross-flow capture for the three frozen Fluid fToken vaults.
set -u

script_path=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
if [ "${1-}" != '--locked' ]; then
  # The inherited advisory lock follows Python through exec and disappears on
  # process exit, including a hard timeout. A duplicate launch skips cleanly.
  exec /usr/bin/python3 - "$script_path" <<'PY'
import fcntl
import os
import sys

path = os.path.join(os.environ.get('TMPDIR') or '/private/tmp', 'membrane-carry-fluid-ftoken-flow.lock')
fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    print('carry-fluid-ftoken-flow:already-running', flush=True)
    sys.exit(0)
os.set_inheritable(fd, True)
os.execv('/bin/sh', ['/bin/sh', sys.argv[1], '--locked'])
PY
fi

cd "$(dirname "$0")/.." || exit 1
echo "carry-fluid-ftoken-flow:start $(date -u +%Y-%m-%dT%H:%M:%SZ)"
node_bin=${FLUID_FLOW_NODE_BIN:-/opt/homebrew/bin/node}
timeout_bin=${FLUID_FLOW_TIMEOUT_BIN:-/opt/homebrew/bin/timeout}

# The recorder itself caps each tick at four contiguous 8-block ranges,
# 192 RPC calls, 4 MiB of RPC responses, 240 seconds, and 2 GiB disk reserve.
if "$timeout_bin" -k 5s 250s "$node_bin" --max-old-space-size=384 scripts/research/fluid-ftoken-gross-flow.mjs --capture-next; then
  echo 'carry-fluid-ftoken-flow:ok'
else
  status=$?
  echo "carry-fluid-ftoken-flow:failed (exit $status)" >&2
  exit "$status"
fi
