#!/bin/sh
# Local public-chain-only direct-market prospective issue and due-score ticks.
set -u

mode=${1-}
case "$mode" in
  issue-aave|issue-aave-campaign|issue-aave-usde|issue-aave-usde-campaign|issue-spark|issue-spark-campaign|issue-aave-common|score|score-direct-campaign|score-spark-campaign) ;;
  *) echo 'public-direct-exit:usage' >&2; exit 2 ;;
esac

script_path=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
if [ "${2-}" != '--locked' ]; then
  exec /usr/bin/python3 - "$script_path" "$mode" <<'PY'
import fcntl
import os
import sys

try:
    path = os.path.join(os.environ.get('TMPDIR') or '/private/tmp',
                        'membrane-public-direct-exit.lock')
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    os.set_inheritable(fd, True)
    os.execv('/bin/sh', ['/bin/sh', sys.argv[1], sys.argv[2], '--locked'])
except BlockingIOError:
    if sys.argv[2] in ('issue-spark-campaign', 'issue-aave-campaign', 'issue-aave-usde-campaign', 'score-spark-campaign', 'score-direct-campaign'):
        print('public-direct-exit:busy', file=sys.stderr, flush=True)
        sys.exit(75)
    print('public-direct-exit:busy', flush=True)
    sys.exit(0)
except Exception:
    print('public-direct-exit:lock-failed', file=sys.stderr, flush=True)
    sys.exit(1)
PY
fi

cd "$(dirname "$0")/.." || exit 1
node_bin=${PUBLIC_DIRECT_NODE_BIN:-/opt/homebrew/bin/node}
timeout_bin=${PUBLIC_DIRECT_TIMEOUT_BIN:-/opt/homebrew/bin/timeout}
date_bin=${PUBLIC_DIRECT_DATE_BIN:-/bin/date}

run_aave_frozen_q_issue() {
  issue_timeout=$1
  if issue_result=$(NODE_OPTIONS='--max-old-space-size=384' "$timeout_bin" -k 5s "${issue_timeout}s" "$node_bin" scripts/research/carry-public-aave-usdc-fixed-q-v2-issue.mjs --issue-latest 2>/dev/null); then
    case "$issue_result" in
      *'"status":"issued"'*) echo 'public-direct-exit:aave-frozen-q-issue:issued' ;;
      *'"status":"no_eligible_fresh_v1_issue"'*) echo 'public-direct-exit:aave-frozen-q-issue:no-eligible' ;;
      *) echo 'public-direct-exit:aave-frozen-q-issue:invalid-result' >&2; return 1 ;;
    esac
    return 0
  fi
  echo 'public-direct-exit:aave-frozen-q-issue:failed' >&2
  return 1
}

run_aave_common_q_issue() {
  if [ "${PUBLIC_AAVE_COMMON_Q_V3_ENABLED:-0}" != 1 ]; then
    echo 'public-direct-exit:aave-common-q-issue:disabled'
    return 0
  fi
  if issue_result=$(NODE_OPTIONS='--max-old-space-size=384' "$timeout_bin" -k 5s 120s "$node_bin" scripts/research/carry-public-aave-usdc-common-q-v3-issue.mjs --issue-latest 2>/dev/null); then
    case "$issue_result" in
      *'"status":"issued"'*) echo 'public-direct-exit:aave-common-q-issue:issued' ;;
      *'"status":"no_eligible_fresh_v1_issue"'*) echo 'public-direct-exit:aave-common-q-issue:no-eligible' ;;
      *'"status":"retry_original_origins_unavailable"'*) echo 'public-direct-exit:aave-common-q-issue:retry-origins' ;;
      *'"status":"operator_diagnostic_recorded"'*) echo 'public-direct-exit:aave-common-q-issue:operator-diagnostic-retryable' ;;
      *) echo 'public-direct-exit:aave-common-q-issue:invalid-result' >&2; return 1 ;;
    esac
    return 0
  fi
  echo 'public-direct-exit:aave-common-q-issue:failed' >&2
  return 1
}

if [ "$mode" = issue-aave-common ]; then
  run_aave_common_q_issue
  exit $?
fi

if [ "$mode" = score-spark-campaign ]; then
  if NODE_OPTIONS='--max-old-space-size=384' "$timeout_bin" -k 5s 360s "$node_bin" scripts/record-carry-public-spark-usdt-exit-scores.mjs --sweep >/dev/null 2>&1; then
    echo 'public-direct-exit:score-spark-campaign:ok'
    exit 0
  fi
  echo 'public-direct-exit:score-spark-campaign:failed' >&2
  exit 1
fi

if [ "$mode" = score-direct-campaign ]; then
  if NODE_OPTIONS='--max-old-space-size=384' "$timeout_bin" -k 5s 360s "$node_bin" scripts/record-carry-public-direct-exit-scores.mjs --sweep >/dev/null 2>&1; then
    echo 'public-direct-exit:score-direct-campaign:ok'
    exit 0
  fi
  echo 'public-direct-exit:score-direct-campaign:failed' >&2
  exit 1
fi

if [ "$mode" = score ]; then
  minute=$($date_bin +%M) || exit 1
  second=$($date_bin +%S) || exit 1
  minute=${minute#0}
  second=${second#0}
  minute=${minute:-0}
  second=${second:-0}
  if [ "$minute" -lt 18 ]; then
    next_issue=18
  elif [ "$minute" -lt 48 ]; then
    next_issue=48
  elif [ "$minute" -lt 58 ]; then
    next_issue=58
  else
    next_issue=78
  fi
  # End a score sweep at least one minute before the next hourly issue slot.
  limit=$(((next_issue - minute) * 60 - second - 60))
  if [ "$limit" -lt 60 ]; then
    echo 'public-direct-exit:score:deferred'
    exit 0
  fi
  if [ "$limit" -gt 360 ]; then limit=360; fi
  if [ "$limit" -lt 240 ]; then
    if NODE_OPTIONS='--max-old-space-size=384' "$timeout_bin" -k 5s "${limit}s" "$node_bin" scripts/record-carry-public-direct-exit-scores.mjs --sweep >/dev/null 2>&1; then
      echo 'public-direct-exit:score:ok'
      exit 0
    fi
    echo 'public-direct-exit:score:failed' >&2
    exit 1
  fi
  score_failed=0
  run_aave_frozen_q_issue 45 || score_failed=1
  if ! NODE_OPTIONS='--max-old-space-size=384' "$timeout_bin" -k 5s 120s "$node_bin" scripts/record-carry-public-aave-usdc-fixed-q-v2-scores.mjs --sweep 2>/dev/null; then
    echo 'public-direct-exit:aave-frozen-q-score:failed' >&2
    score_failed=1
  fi
  common_score=0
  if [ "${PUBLIC_AAVE_COMMON_Q_V3_ENABLED:-0}" = 1 ] && [ $((minute % 20)) -eq 11 ] && [ "$limit" -ge 300 ]; then
    common_score=1
  fi
  remaining=$((limit - 165 - common_score * 60))
  if NODE_OPTIONS='--max-old-space-size=384' "$timeout_bin" -k 5s "${remaining}s" "$node_bin" scripts/record-carry-public-direct-exit-scores.mjs --sweep >/dev/null 2>&1; then
    echo 'public-direct-exit:score:ok'
  else
    echo 'public-direct-exit:score:failed' >&2
    score_failed=1
  fi
  if [ "$common_score" -eq 1 ]; then
    if NODE_OPTIONS='--max-old-space-size=384' "$timeout_bin" -k 5s 60s "$node_bin" scripts/record-carry-public-aave-usdc-common-q-v3-scores.mjs --sweep >/dev/null 2>&1; then
      echo 'public-direct-exit:aave-common-q-score:ok'
    else
      echo 'public-direct-exit:aave-common-q-score:failed' >&2
      score_failed=1
    fi
  fi
  exit "$score_failed"
fi

case "$mode" in
  issue-aave|issue-aave-campaign) market=aaveV3Usdc ;;
  issue-aave-usde|issue-aave-usde-campaign) market=aaveV3Usde ;;
  issue-spark|issue-spark-campaign) market=sparkLendUsdt ;;
esac
case "$mode" in
  *-campaign) export HOLDER_EXIT_REQUIRE_FRESH_FLOW=1 ;;
esac
if NODE_OPTIONS='--max-old-space-size=384' "$timeout_bin" -k 5s 540s "$node_bin" scripts/research/carry-public-direct-exit-issue.mjs --issue "$market" >/dev/null 2>&1; then
  if [ "$mode" = issue-aave ]; then run_aave_frozen_q_issue 90 || exit 1; fi
  echo "public-direct-exit:$mode:ok"
else
  echo "public-direct-exit:$mode:failed" >&2
  exit 1
fi
