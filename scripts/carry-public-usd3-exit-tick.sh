#!/bin/sh
# Local public-chain-only USD3 issue and due-score ticks.
set -u

mode=${1-}
case "$mode" in
  issue|score|score-campaign) ;;
  *) echo 'public-usd3-exit:usage' >&2; exit 2 ;;
esac

# The old standalone :36 score slot defers around its separate :31 issue job.
# The single campaign serializes issue and score under this wrapper's lock.
date_bin=${PUBLIC_USD3_DATE_BIN:-/bin/date}
if [ "$mode" = score ] && [ "$("$date_bin" +%M)" = 36 ]; then
  echo 'public-usd3-exit:score:deferred'
  exit 0
fi

script_path=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
if [ "${2-}" != '--locked' ]; then
  exec /usr/bin/python3 - "$script_path" "$mode" <<'PY'
import fcntl
import os
import sys

try:
    path = os.path.join(os.environ.get('TMPDIR') or '/private/tmp',
                        'membrane-public-usd3-exit.lock')
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    os.set_inheritable(fd, True)
    os.execv('/bin/sh', ['/bin/sh', sys.argv[1], sys.argv[2], '--locked'])
except BlockingIOError:
    print('public-usd3-exit:busy', file=sys.stderr, flush=True)
    # The campaign reserved this lane before dispatch. A busy lock did not
    # measure the holder, so report failure and leave a retry visible.
    sys.exit(75 if sys.argv[2] == 'score-campaign' else 0)
except Exception:
    print('public-usd3-exit:lock-failed', file=sys.stderr, flush=True)
    sys.exit(1)
PY
fi

cd "$(dirname "$0")/.." || exit 1
node_bin=${PUBLIC_USD3_NODE_BIN:-/opt/homebrew/bin/node}
timeout_bin=${PUBLIC_USD3_TIMEOUT_BIN:-/opt/homebrew/bin/timeout}

if [ "$mode" = issue ]; then
  if "$timeout_bin" -k 5s 540s "$node_bin" --max-old-space-size=384 scripts/research/carry-public-usd3-exit-attempt.mjs --issue >/dev/null 2>&1; then
    echo 'public-usd3-exit:issue:ok'
    exit 0
  fi
  echo 'public-usd3-exit:issue:failed' >&2
  exit 1
fi

if "$timeout_bin" -k 5s 330s "$node_bin" --max-old-space-size=384 scripts/research/carry-public-usd3-exit-attempt.mjs --score >/dev/null 2>&1; then
  echo 'public-usd3-exit:score:ok'
  exit 0
fi
echo 'public-usd3-exit:score:failed' >&2
exit 1
