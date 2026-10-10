#!/bin/sh
# Native Mac read-only Saturn holder issue/score tick.
set -u
mode=${1-}
case "$mode" in issue|score) ;; *) echo 'saturn-holder:usage' >&2; exit 2 ;; esac
script_path=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
if [ "${2-}" != '--locked' ]; then
  exec /usr/bin/python3 - "$script_path" "$mode" <<'PY'
import fcntl
import os
import sys
try:
    path = os.path.join(os.environ.get('TMPDIR') or '/private/tmp', 'membrane-local-staked-usdat-holder.lock')
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    os.set_inheritable(fd, True)
    os.execv('/bin/sh', ['/bin/sh', sys.argv[1], sys.argv[2], '--locked'])
except BlockingIOError:
    print('saturn-holder:busy', flush=True)
    sys.exit(0)
except Exception:
    print('saturn-holder:lock-failed', file=sys.stderr, flush=True)
    sys.exit(1)
PY
fi
cd "$(dirname "$0")/.." || exit 1
node_bin=${STAKED_USDAT_HOLDER_NODE_BIN:-/opt/homebrew/bin/node}
timeout_bin=${STAKED_USDAT_HOLDER_TIMEOUT_BIN:-/opt/homebrew/bin/timeout}
if [ "$mode" = issue ]; then limit=540; else limit=360; fi
if "$timeout_bin" -k 5s "${limit}s" "$node_bin" --import tsx scripts/research/carry-local-staked-usdat-holder.mjs "$mode" >/dev/null 2>&1; then
  echo "saturn-holder:$mode:ok"
  exit 0
fi
echo "saturn-holder:$mode:failed" >&2
exit 1
