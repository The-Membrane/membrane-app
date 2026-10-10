#!/bin/sh
# Bounded local prospective gross-flow tick for three frozen direct vaults.
set -u

script_path=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
if [ "${1-}" != '--locked' ]; then
  exec /usr/bin/python3 - "$script_path" <<'PY'
import fcntl
import os
import sys

path = os.path.join(os.environ.get('TMPDIR') or '/private/tmp', 'membrane-carry-direct-vault-flow.lock')
fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    print('carry-direct-vault-flow:already-running', flush=True)
    sys.exit(0)
os.set_inheritable(fd, True)
os.execv('/bin/sh', ['/bin/sh', sys.argv[1], '--locked'])
PY
fi

cd "$(dirname "$0")/.." || exit 1
echo "carry-direct-vault-flow:start $(date -u +%Y-%m-%dT%H:%M:%SZ)"
node_bin=${DIRECT_VAULT_FLOW_NODE_BIN:-/opt/homebrew/bin/node}
timeout_bin=${DIRECT_VAULT_FLOW_TIMEOUT_BIN:-/opt/homebrew/bin/timeout}

# Recorder: at most four contiguous 8-block ranges, 192 RPC calls,
# 4 MiB responses, 210 seconds, 2 GiB free-disk reserve.
if "$timeout_bin" -k 5s 225s "$node_bin" --max-old-space-size=384 scripts/research/carry-direct-vault-gross-flow.mjs --capture-next; then
  echo 'carry-direct-vault-flow:ok'
else
  status=$?
  echo "carry-direct-vault-flow:failed (exit $status)" >&2
  exit "$status"
fi
