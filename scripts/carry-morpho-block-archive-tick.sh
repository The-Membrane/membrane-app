#!/bin/sh
# One resumable retrospective bundle per local tick. The pilot and campaign
# are immutable chains; this does not write to the live forecast.
set -eu

script_path=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
if [ "${1-}" != '--locked' ]; then
  exec /usr/bin/python3 - "$script_path" <<'PY'
import fcntl
import os
import sys

path = os.path.join(os.environ.get('TMPDIR') or '/private/tmp', 'membrane-carry-morpho-block-archive.lock')
fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    print('carry-morpho-block-archive:already-running', flush=True)
    sys.exit(0)
os.set_inheritable(fd, True)
os.execv('/bin/sh', ['/bin/sh', sys.argv[1], '--locked'])
PY
fi

cd "$(dirname "$0")/.."
export CARRY_MORPHO_ARCHIVE_ORIGINS=rpc.ankr.com,eth-mainnet.g.alchemy.com
export CARRY_MORPHO_ARCHIVE_BUNDLE_BLOCKS=64
exec /opt/homebrew/bin/timeout -k 10s 240s /opt/homebrew/bin/node scripts/research/record-carry-morpho-v2-block-archive.mjs --campaign-tick
