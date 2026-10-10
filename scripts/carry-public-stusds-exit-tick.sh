#!/bin/sh
# Local public-chain-only StUsds issue and due-score ticks.
set -u

mode=${1-}
case "$mode" in
  issue|score|issue-campaign|score-campaign) ;;
  *) echo 'public-stusds-exit:usage' >&2; exit 2 ;;
esac

# Give the hourly :31 issue a clear start: the :36 score slot is retried at
# :46 and every later ten-minute slot, within the two-hour capture window.
date_bin=${PUBLIC_STUSDS_DATE_BIN:-/bin/date}
if [ "$mode" = score ] && [ "$("$date_bin" +%M)" = 36 ]; then
  echo 'public-stusds-exit:score:deferred'
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
                        'membrane-public-stusds-exit.lock')
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    os.set_inheritable(fd, True)
    os.execv('/bin/sh', ['/bin/sh', sys.argv[1], sys.argv[2], '--locked'])
except BlockingIOError:
    print('public-stusds-exit:busy', file=sys.stderr, flush=True)
    sys.exit(75 if sys.argv[2].endswith('-campaign') else 0)
except Exception:
    print('public-stusds-exit:lock-failed', file=sys.stderr, flush=True)
    sys.exit(1)
PY
fi

cd "$(dirname "$0")/.." || exit 1
node_bin=${PUBLIC_STUSDS_NODE_BIN:-/opt/homebrew/bin/node}
timeout_bin=${PUBLIC_STUSDS_TIMEOUT_BIN:-/opt/homebrew/bin/timeout}

if [ "$mode" = issue ] || [ "$mode" = issue-campaign ]; then
  if "$timeout_bin" -k 5s 540s "$node_bin" --max-old-space-size=384 scripts/research/carry-public-stusds-exit-attempt.mjs --issue >/dev/null 2>&1; then
    echo 'public-stusds-exit:issue:ok'
    exit 0
  fi
  echo 'public-stusds-exit:issue:failed' >&2
  exit 1
fi

if "$timeout_bin" -k 5s 330s "$node_bin" --max-old-space-size=384 scripts/research/carry-public-stusds-exit-attempt.mjs --score >/dev/null 2>&1; then
  echo 'public-stusds-exit:score:ok'
  exit 0
fi
echo 'public-stusds-exit:score:failed' >&2
exit 1
