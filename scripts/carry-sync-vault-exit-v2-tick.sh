#!/bin/sh
# Local Mac v2 synchronous-vault prospective issue/witness and outcome-score jobs.
# Distinct locks keep a slow score pass from suppressing a 15-minute issue.
set -u

mode=${1-}
case "$mode" in
  issue|score) ;;
  *) echo 'carry-sync-vault-exit-v2:usage issue|score' >&2; exit 2 ;;
esac

script_path=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
if [ "${2-}" != '--locked' ]; then
  exec /usr/bin/python3 - "$script_path" "$mode" <<'PY'
import fcntl
import os
import sys

path = os.path.join(os.environ.get('TMPDIR') or '/private/tmp',
                    'membrane-carry-sync-vault-exit-v2-' + sys.argv[2] + '.lock')
fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    print('carry-sync-vault-exit-v2:' + sys.argv[2] + ':already-running',
          file=sys.stderr, flush=True)
    sys.exit(1)
os.set_inheritable(fd, True)
os.execv('/bin/sh', ['/bin/sh', sys.argv[1], sys.argv[2], '--locked'])
PY
fi

cd "$(dirname "$0")/.." || exit 1
node_bin=${CARRY_EXIT_V2_NODE_BIN:-/opt/homebrew/bin/node}
timeout_bin=${CARRY_EXIT_V2_TIMEOUT_BIN:-/opt/homebrew/bin/timeout}
failed=0
run_stage() {
  stage=$1
  limit=$2
  shift 2
  # The JS CLIs print only aggregate status today, but this boundary keeps
  # future holder/Q/provider details out of persistent launchd logs as well.
  if "$timeout_bin" -k 5s "$limit" "$node_bin" "$@" >/dev/null 2>&1; then
    echo "carry-sync-vault-exit-v2:$stage ok"
  else
    status=$?
    echo "carry-sync-vault-exit-v2:$stage failed (exit $status)" >&2
    failed=1
  fi
}

if [ "$mode" = issue ]; then
  # The witness runs from a distinct autocommit process after the issuer exits.
  # It also observes previously committed batches if this issue attempt failed.
  run_stage issue 300s scripts/record-carry-sync-vault-exit-v2-issues.mjs
  run_stage witness 120s scripts/record-carry-exit-v2-issue-witness.mjs
else
  run_stage score 630s scripts/record-carry-sync-vault-exit-v2-scores.mjs
fi

if [ "$failed" -ne 0 ]; then
  echo "carry-sync-vault-exit-v2:$mode tick failed" >&2
  exit 1
fi
echo "carry-sync-vault-exit-v2:$mode tick ok"
