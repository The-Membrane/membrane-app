#!/bin/sh
# Native local Fluid fToken same-holder issue/score recorder.
set -u
mode=${1-}
case "$mode" in
  issue|score) ;;
  *) echo 'fluid-holder:usage' >&2; exit 2 ;;
esac

script_path=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
if [ "${2-}" != '--locked' ]; then
  exec /usr/bin/python3 - "$script_path" "$mode" <<'PY'
import fcntl, os, sys
try:
    path = os.path.join(os.environ.get('TMPDIR') or '/private/tmp', 'membrane-fluid-holder.lock')
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    os.set_inheritable(fd, True)
    os.execv('/bin/sh', ['/bin/sh', sys.argv[1], sys.argv[2], '--locked'])
except BlockingIOError:
    print('fluid-holder:busy', flush=True)
    sys.exit(0)
except Exception:
    print('fluid-holder:lock-failed', file=sys.stderr, flush=True)
    sys.exit(1)
PY
fi

cd "$(dirname "$0")/.." || exit 1
node_bin=${FLUID_HOLDER_NODE_BIN:-/opt/homebrew/bin/node}
timeout_bin=${FLUID_HOLDER_TIMEOUT_BIN:-/opt/homebrew/bin/timeout}
if "$timeout_bin" -k 5s 150s "$node_bin" --max-old-space-size=384 scripts/research/carry-fluid-ftoken-holder.mjs "$mode"; then
  echo "fluid-holder:$mode:ok"
  exit 0
fi
echo "fluid-holder:$mode:failed" >&2
exit 1
