#!/bin/sh
# Single local campaign dispatcher. The lock lives for the entire evidence lane.
set -eu

script_path=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
if [ "${1-}" != '--locked' ]; then
  exec /usr/bin/python3 - "$script_path" <<'PY'
import fcntl
import os
import sys

path = os.path.join(os.environ.get('TMPDIR') or '/private/tmp', 'membrane-holder-exit-campaign.lock')
try:
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    print('holder-exit-campaign:already-running')
    sys.exit(0)
except Exception:
    print('holder-exit-campaign:lock-unavailable', file=sys.stderr)
    sys.exit(1)
os.set_inheritable(fd, True)
os.execv('/bin/sh', ['/bin/sh', sys.argv[1], '--locked'])
PY
fi

cd "$(dirname "$0")/.."
disk_mode=$(/usr/bin/python3 - <<'PY'
import os

stat = os.statvfs('data/research/venue-signals')
free_bytes = stat.f_bavail * stat.f_frsize
if os.environ.get('HOLDER_EXIT_CAMPAIGN_TEST_MODE') == '1':
    free_bytes = min(free_bytes, int(os.environ['HOLDER_EXIT_CAMPAIGN_TEST_FREE_BYTES']))
if free_bytes < 1024 * 1024 * 1024 + 262144:
    print('blocked')
elif free_bytes < 3 * 1024 * 1024 * 1024:
    print('light')
else:
    print('full')
PY
)
if [ "$disk_mode" = blocked ]; then
  echo 'holder-exit-campaign:disk-reserve' >&2
  exit 0
fi

if [ "$disk_mode" = light ]; then
  exec /usr/bin/nice -n 10 /opt/homebrew/bin/timeout -k 10s 590s \
    /opt/homebrew/bin/node --max-old-space-size=384 --import tsx \
    scripts/research/holder-exit-campaign-plan.mjs --light
fi

exec /usr/bin/nice -n 10 /opt/homebrew/bin/timeout -k 10s 590s \
  /opt/homebrew/bin/node --max-old-space-size=384 --import tsx \
  scripts/research/holder-exit-campaign-plan.mjs
