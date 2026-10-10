#!/bin/sh
# Local, bounded Hastra PRIME → wYLDS issue/score ticks.
set -u

mode=${1-}
case "$mode" in
  issue|score|issue-campaign|score-campaign) ;;
  *) echo 'pyusd-prime-prospective:usage' >&2; exit 2 ;;
esac

script_path=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
if [ "${2-}" != '--locked' ]; then
  exec /usr/bin/python3 - "$script_path" "$mode" <<'PY'
import fcntl
import os
import sys

try:
    path = os.path.join(os.environ.get('TMPDIR') or '/private/tmp',
                        'membrane-pyusd-prime-prospective.lock')
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    os.set_inheritable(fd, True)
    os.execv('/bin/sh', ['/bin/sh', sys.argv[1], sys.argv[2], '--locked'])
except BlockingIOError:
    print('pyusd-prime-prospective:busy', flush=True)
    sys.exit(75 if sys.argv[2].endswith('-campaign') else 0)
except Exception:
    print('pyusd-prime-prospective:lock-failed', file=sys.stderr, flush=True)
    sys.exit(1)
PY
fi

cd "$(dirname "$0")/.." || exit 1
node_bin=${PUBLIC_PYUSD_PRIME_NODE_BIN:-/opt/homebrew/bin/node}
timeout_bin=${PUBLIC_PYUSD_PRIME_TIMEOUT_BIN:-/opt/homebrew/bin/timeout}
case "$mode" in
  issue-campaign) limit=500 ;;
  score-campaign) limit=450 ;;
  *) limit=330 ;;
esac
if "$timeout_bin" -k 5s "${limit}s" "$node_bin" --max-old-space-size=384 scripts/research/pyusd-staking-prospective.mjs "--$mode" >/dev/null 2>&1; then
  echo "pyusd-prime-prospective:$mode:ok"
  exit 0
fi
echo "pyusd-prime-prospective:$mode:failed" >&2
exit 1
