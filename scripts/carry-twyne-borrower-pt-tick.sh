#!/bin/sh
# Local read-only Twyne borrower PT first-leg recorder; one process at a time.
set -eu

mode=${1-}
case "$mode" in
  --issue|--score) ;;
  *) echo 'twyne-borrower-pt:usage' >&2; exit 2 ;;
esac

script_path=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
if [ "${2-}" != '--locked' ]; then
  exec /usr/bin/python3 - "$script_path" "$mode" <<'PY'
import fcntl
import os
import sys

path = os.path.join(os.environ.get('TMPDIR') or '/private/tmp', 'membrane-twyne-borrower-pt.lock')
fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    print('twyne-borrower-pt:already-running', flush=True)
    sys.exit(0)
os.set_inheritable(fd, True)
os.execv('/bin/sh', ['/bin/sh', sys.argv[1], sys.argv[2], '--locked'])
PY
fi

cd "$(dirname "$0")/.."
exec /usr/bin/nice -n 10 /opt/homebrew/bin/timeout -k 10s 150s \
  /opt/homebrew/bin/node --max-old-space-size=384 --import tsx \
  scripts/research/carry-twyne-borrower-pt.mjs "$mode"
