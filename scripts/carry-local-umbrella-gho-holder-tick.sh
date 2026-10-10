#!/bin/sh
# Native Mac read-only Umbrella holder issue/score tick; no private child output in logs.
set -u
mode=${1-}
case "$mode" in issue|seed|score|issue-campaign|score-campaign) ;; *) echo 'umbrella-holder:usage' >&2; exit 2 ;; esac
script_path=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
if [ "${2-}" != '--locked' ]; then
  exec /usr/bin/python3 - "$script_path" "$mode" <<'PY'
import fcntl
import os
import sys
try:
    path = os.path.join(os.environ.get('TMPDIR') or '/private/tmp', 'membrane-local-umbrella-gho-holder.lock')
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    os.set_inheritable(fd, True)
    os.execv('/bin/sh', ['/bin/sh', sys.argv[1], sys.argv[2], '--locked'])
except BlockingIOError:
    print('umbrella-holder:busy', file=sys.stderr, flush=True)
    sys.exit(75 if sys.argv[2].endswith('-campaign') else 0)
except Exception:
    print('umbrella-holder:lock-failed', file=sys.stderr, flush=True)
    sys.exit(1)
PY
fi
cd "$(dirname "$0")/.." || exit 1
node_bin=${UMBRELLA_HOLDER_NODE_BIN:-/opt/homebrew/bin/node}
timeout_bin=${UMBRELLA_HOLDER_TIMEOUT_BIN:-/opt/homebrew/bin/timeout}
case "$mode" in
  issue) limit=540; cli_mode=issue ;;
  seed) limit=240; cli_mode=issue-seed ;;
  score) limit=360; cli_mode=score ;;
  issue-campaign) limit=500; cli_mode=issue-seed ;;
  score-campaign) limit=450; cli_mode=score ;;
esac
if "$timeout_bin" -k 5s "${limit}s" "$node_bin" --max-old-space-size=384 --import tsx scripts/research/carry-local-umbrella-gho-holder.mjs "$cli_mode" >/dev/null 2>&1; then
  echo "umbrella-holder:$mode:ok"
  exit 0
fi
echo "umbrella-holder:$mode:failed" >&2
exit 1
