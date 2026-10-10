#!/bin/sh
# One independently paired Aave USDC market-cash slice per local tick.
set -eu

script_path=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
if [ "${1-}" != '--locked' ]; then
  exec /usr/bin/python3 - "$script_path" <<'PY'
import fcntl
import os
import sys

path = os.path.join(os.environ.get('TMPDIR') or '/private/tmp', 'membrane-aave-usdc-cash-archive.lock')
fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    print('aave-usdc-cash-archive:already-running', flush=True)
    sys.exit(0)
os.set_inheritable(fd, True)
os.execv('/bin/sh', ['/bin/sh', sys.argv[1], '--locked'])
PY
fi

cd "$(dirname "$0")/.."
if ! /usr/bin/python3 - <<'PY'
import os
import sys

stat = os.statvfs('data/research/venue-signals')
if stat.f_bavail * stat.f_frsize < 2 * 1024 * 1024 * 1024:
    print('aave-usdc-cash-archive:disk-reserve', file=sys.stderr)
    sys.exit(1)
PY
then
  exit 1
fi

exec /usr/bin/nice -n 10 /opt/homebrew/bin/timeout -k 10s 240s \
  /opt/homebrew/bin/node --max-old-space-size=512 \
  scripts/research/aave-usdc-market-cash-archive-v2.mjs --tick
