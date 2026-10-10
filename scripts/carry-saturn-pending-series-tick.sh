#!/bin/sh
set -eu

# Invoked inside the existing single locked campaign dispatcher; no separate job.
cd "$(dirname "$0")/.."
mode=${1---capture}
case "$mode" in
  --capture|--verify) ;;
  *) echo 'saturn-series:usage' >&2; exit 2 ;;
esac
exec /opt/homebrew/bin/timeout -k 10s 540s \
  /opt/homebrew/bin/node --max-old-space-size=384 --import tsx \
  scripts/research/saturn-queue-pending-series.mjs "$mode"
