#!/bin/sh
# Local public-chain-only StUsds issue and due-score ticks.
set -u

mode=${1-}
case "$mode" in
  issue|score) ;;
  *) echo 'public-apyusd-exit:usage' >&2; exit 2 ;;
esac

script_path=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
if [ "${2-}" != '--locked' ]; then
  exec /usr/bin/python3 - "$script_path" "$mode" <<'PY'
import fcntl
import os
import sys

try:
    path = os.path.join(os.environ.get('TMPDIR') or '/private/tmp',
                        'membrane-public-apyusd-exit.lock')
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    os.set_inheritable(fd, True)
    os.execv('/bin/sh', ['/bin/sh', sys.argv[1], sys.argv[2], '--locked'])
except BlockingIOError:
    print('public-apyusd-exit:busy', flush=True)
    sys.exit(0)
except Exception:
    print('public-apyusd-exit:lock-failed', file=sys.stderr, flush=True)
    sys.exit(1)
PY
fi

cd "$(dirname "$0")/.." || exit 1
node_bin=${PUBLIC_APYUSD_NODE_BIN:-/opt/homebrew/bin/node}
timeout_bin=${PUBLIC_APYUSD_TIMEOUT_BIN:-/opt/homebrew/bin/timeout}

if [ "$mode" = issue ]; then
  if "$timeout_bin" -k 5s 540s "$node_bin" --max-old-space-size=384 scripts/research/carry-public-apyusd-exit-attempt.mjs --issue >/dev/null 2>&1; then
    echo 'public-apyusd-exit:issue:ok'
    exit 0
  fi
  echo 'public-apyusd-exit:issue:failed' >&2
  exit 1
fi

if "$timeout_bin" -k 5s 330s "$node_bin" --max-old-space-size=384 scripts/research/carry-public-apyusd-exit-attempt.mjs --score >/dev/null 2>&1; then
  echo 'public-apyusd-exit:score:ok'
  exit 0
fi
echo 'public-apyusd-exit:score:failed' >&2
exit 1
