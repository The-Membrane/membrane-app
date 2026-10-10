#!/bin/sh
# Local public-chain-only sGHO issue and due-score ticks.
set -u

mode=${1-}
case "$mode" in
  issue|score|issue-campaign|score-campaign|fixed-q-issue-campaign|fixed-q-score-campaign) ;;
  *) echo 'public-sgho-exit:usage' >&2; exit 2 ;;
esac

script_path=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
if [ "${2-}" != '--locked' ]; then
  exec /usr/bin/python3 - "$script_path" "$mode" <<'PY'
import fcntl
import os
import sys

try:
    path = os.path.join(os.environ.get('TMPDIR') or '/private/tmp',
                        'membrane-public-sgho-exit.lock')
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    os.set_inheritable(fd, True)
    os.execv('/bin/sh', ['/bin/sh', sys.argv[1], sys.argv[2], '--locked'])
except BlockingIOError:
    print('public-sgho-exit:busy', file=sys.stderr, flush=True)
    sys.exit(75 if sys.argv[2].endswith('-campaign') else 0)
except Exception:
    print('public-sgho-exit:lock-failed', file=sys.stderr, flush=True)
    sys.exit(1)
PY
fi

cd "$(dirname "$0")/.." || exit 1
node_bin=${PUBLIC_SGHO_NODE_BIN:-/opt/homebrew/bin/node}
timeout_bin=${PUBLIC_SGHO_TIMEOUT_BIN:-/opt/homebrew/bin/timeout}

run_fixed_q_issue() {
  issue_timeout=$1
  issue_mode=${2---issue-latest}
  if issue_result=$(NODE_OPTIONS='--max-old-space-size=384' "$timeout_bin" -k 5s "${issue_timeout}s" "$node_bin" scripts/research/carry-public-sgho-fixed-q-v2-issue.mjs "$issue_mode" 2>/dev/null); then
    case "$issue_result" in
      *'"status":"issued"'*) echo 'public-sgho-exit:fixed-q-issue:issued' ;;
      *'"status":"no_eligible_fresh_v1_issue"'*) echo 'public-sgho-exit:fixed-q-issue:no-eligible' ;;
      *'"status":"retry_baseline_replay"'*)
        if [ "$issue_mode" = --issue-due ]; then
          echo 'public-sgho-exit:fixed-q-issue:retry' >&2
          return 1
        fi
        echo 'public-sgho-exit:fixed-q-issue:retry' ;;
      *) echo 'public-sgho-exit:fixed-q-issue:invalid-result' >&2; return 1 ;;
    esac
    return 0
  fi
  echo 'public-sgho-exit:fixed-q-issue:failed' >&2
  return 1
}

if [ "$mode" = issue ] || [ "$mode" = issue-campaign ]; then
  if NODE_OPTIONS='--max-old-space-size=384' "$timeout_bin" -k 5s 540s "$node_bin" scripts/research/carry-public-sgho-exit-issue.mjs --issue >/dev/null 2>&1; then
    if [ "$mode" = issue ]; then
      run_fixed_q_issue 180 || exit 1
    fi
    echo 'public-sgho-exit:issue:ok'
    exit 0
  fi
  echo 'public-sgho-exit:issue:failed' >&2
  exit 1
fi

if [ "$mode" = fixed-q-issue-campaign ]; then
  run_fixed_q_issue 180 --issue-due
  exit $?
fi

if [ "$mode" = fixed-q-score-campaign ]; then
  if NODE_OPTIONS='--max-old-space-size=384' "$timeout_bin" -k 5s 330s "$node_bin" scripts/record-carry-public-sgho-fixed-q-v2-scores.mjs --sweep >/dev/null 2>&1; then
    echo 'public-sgho-exit:fixed-q-score:ok'
    exit 0
  fi
  echo 'public-sgho-exit:fixed-q-score:failed' >&2
  exit 1
fi

score_failed=0
if [ "$mode" = score ]; then
  run_fixed_q_issue 90 || score_failed=1
  if ! NODE_OPTIONS='--max-old-space-size=384' "$timeout_bin" -k 5s 150s "$node_bin" scripts/record-carry-public-sgho-fixed-q-v2-scores.mjs --sweep >/dev/null 2>&1; then
    echo 'public-sgho-exit:fixed-q-score:failed' >&2
    score_failed=1
  fi
fi
if NODE_OPTIONS='--max-old-space-size=384' "$timeout_bin" -k 5s 330s "$node_bin" scripts/record-carry-public-sgho-exit-scores.mjs --sweep >/dev/null 2>&1; then
  echo 'public-sgho-exit:score:ok'
else
  echo 'public-sgho-exit:score:failed' >&2
  score_failed=1
fi
exit "$score_failed"
