#!/bin/sh
# Resume the fixed Aave USDC supplier-supply gap in bounded local ticks.
set -eu

script_path=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
if [ "${1-}" != '--locked' ]; then
  exec /usr/bin/python3 - "$script_path" <<'PY'
import fcntl
import os
import sys

path = os.path.join(os.environ.get('TMPDIR') or '/private/tmp', 'membrane-aave-usdc-supply-gap.lock')
fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    print('aave-usdc-supply-gap:already-running', flush=True)
    sys.exit(0)
os.set_inheritable(fd, True)
os.execv('/bin/sh', ['/bin/sh', sys.argv[1], '--locked'])
PY
fi

cd "$(dirname "$0")/.."
exec /opt/homebrew/bin/timeout -k 10s 240s /opt/homebrew/bin/node --max-old-space-size=384 \
  scripts/research/aave-usdc-supply-gap-tick.mjs
