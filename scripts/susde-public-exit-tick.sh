#!/bin/sh
# Local Mac public-chain-only sUSDe pending-claim and new-initiation ticks.
set -u

lane=${1-}
mode=${2-}
case "$lane:$mode" in
  pending:issue|pending:score|initiation:issue|initiation:score) ;;
  *) echo 'susde-public-exit:usage' >&2; exit 2 ;;
esac

# These ticks are two minutes after their lane's hourly issue. The next
# ten-minute score slot is inside every two-hour capture window.
date_bin=${SUSDE_PUBLIC_DATE_BIN:-/bin/date}
minute=$("$date_bin" +%M)
if [ "$mode" = score ] && { [ "$lane:$minute" = 'pending:16' ] || [ "$lane:$minute" = 'initiation:49' ]; }; then
  echo "susde-public-exit:$lane:score:deferred"
  exit 0
fi

script_path=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
if [ "${3-}" != '--locked' ]; then
  exec /usr/bin/python3 - "$script_path" "$lane" "$mode" <<'PY'
import fcntl
import os
import sys

try:
    path = os.path.join(os.environ.get('TMPDIR') or '/private/tmp',
                        'membrane-public-susde-' + sys.argv[2] + '.lock')
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    os.set_inheritable(fd, True)
    os.execv('/bin/sh', ['/bin/sh', sys.argv[1], sys.argv[2], sys.argv[3], '--locked'])
except BlockingIOError:
    print('susde-public-exit:' + sys.argv[2] + ':busy', flush=True)
    sys.exit(0)
except Exception:
    print('susde-public-exit:lock-failed', file=sys.stderr, flush=True)
    sys.exit(1)
PY
fi

cd "$(dirname "$0")/.." || exit 1
node_bin=${SUSDE_PUBLIC_NODE_BIN:-/opt/homebrew/bin/node}
timeout_bin=${SUSDE_PUBLIC_TIMEOUT_BIN:-/opt/homebrew/bin/timeout}
if [ "$mode" = issue ]; then
  if [ "$lane" = pending ]; then
    runner=scripts/research/susde-public-pending-exit-issue.mjs
  else
    runner=scripts/research/susde-public-initiation-issue.mjs
  fi
  budget=540s
  flag=--issue
else
  if [ "$lane" = pending ]; then
    runner=scripts/record-susde-public-pending-exit-scores.mjs
  else
    runner=scripts/record-susde-public-initiation-scores.mjs
  fi
  budget=330s
  flag=--sweep
fi

# Child output may contain provider URLs or holder evidence. Drain it in memory,
# retaining only a short issuer-owned error code for the native job log.
exec /usr/bin/python3 - "$lane" "$mode" "$timeout_bin" "$budget" "$node_bin" "$runner" "$flag" <<'PY'
import re
import subprocess
import sys

lane, mode, timeout_bin, budget, node_bin, runner, flag = sys.argv[1:]
prefix = 'susde-public-exit:' + lane + ':' + mode
reason = None
try:
    child = subprocess.Popen(
        [timeout_bin, '-k', '5s', budget, node_bin, runner, flag],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    # Cap line memory even if an upstream process emits untrusted long output.
    candidate = bytearray()
    for chunk in iter(lambda: child.stderr.read(4096), b''):
        for byte in chunk:
            if byte == 10:
                if re.fullmatch(rb'susde_[a-z0-9_]{1,64}', candidate):
                    reason = candidate.decode('ascii')
                candidate.clear()
            elif len(candidate) <= 70:
                candidate.append(byte)
    if re.fullmatch(rb'susde_[a-z0-9_]{1,64}', candidate):
        reason = candidate.decode('ascii')
    status = child.wait()
except Exception:
    status = 1

if status == 0:
    print(prefix + ':ok')
    sys.exit(0)
print(prefix + ':failed' + (':reason=' + reason if reason else ''), file=sys.stderr)
sys.exit(1)
PY
