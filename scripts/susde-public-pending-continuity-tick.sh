#!/bin/sh
# Bounded, resumable public sUSDe issue-3 continuity evidence capture.
set -eu

cd /Users/EBmic/membrane-app
if ! /usr/bin/python3 - <<'PY'
import os
import sys

stat = os.statvfs('data/research/venue-signals')
if stat.f_bavail * stat.f_frsize < 3 * 1024 * 1024 * 1024:
    print('susde-public-pending-continuity:disk-reserve', file=sys.stderr)
    sys.exit(1)
PY
then
  exit 1
fi
/opt/homebrew/bin/timeout -k 5s 185s /opt/homebrew/bin/node --max-old-space-size=384 \
  scripts/research/susde-public-pending-campaign.mjs --tick
