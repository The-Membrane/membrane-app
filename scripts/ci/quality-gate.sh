#!/usr/bin/env bash
#
# Quality gate for membrane-app: typecheck + lint + formatting.
#
# The repo carries a large pre-existing backlog (see .ci/*-baseline.txt), so the
# typecheck and lint checks are RATCHETS, not pass/fail gates: they compare the
# current problem count against a committed baseline and fail only when the count
# goes UP. This blocks newly-introduced errors immediately while leaving the
# existing backlog to be burned down separately.
#
# Baselines may only ever move down. When you fix errors, lower the number in
# .ci/ in the same PR — the gate tells you the new value to write.
#
# Formatting is checked only on files the branch actually touched (BASE_REF),
# because a repo-wide `prettier --write` would rewrite nearly every file.
#
# Usage:
#   pnpm ci:quality                  # typecheck + lint ratchets
#   BASE_REF=origin/main pnpm ci:quality   # ...plus format check on changed files
#
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

TYPECHECK_BASELINE_FILE=".ci/typecheck-baseline.txt"
LINT_BASELINE_FILE=".ci/lint-baseline.txt"

failed=0
declare -a summary=()

hr() { printf '%s\n' "------------------------------------------------------------"; }

# Compare a measured count against its baseline file.
# Fails when above; reports (without failing) when below so the baseline gets tightened.
ratchet() {
  local name="$1" count="$2" baseline_file="$3" logfile="$4"
  local baseline
  baseline="$(tr -d '[:space:]' < "$baseline_file")"

  if [ "$count" -gt "$baseline" ]; then
    echo "FAIL: $name went from $baseline to $count (+$((count - baseline)))."
    echo "      This branch introduces new problems. Full output:"
    echo
    cat "$logfile"
    echo
    summary+=("FAIL  $name: $count (baseline $baseline)")
    failed=1
  elif [ "$count" -lt "$baseline" ]; then
    echo "PASS: $name improved from $baseline to $count."
    echo "      Update $baseline_file to $count so the gain is locked in:"
    echo "        echo $count > $baseline_file"
    summary+=("PASS  $name: $count (baseline $baseline — tighten to $count)")
  else
    echo "PASS: $name holding at baseline ($count)."
    summary+=("PASS  $name: $count (at baseline)")
  fi
}

hr
echo "1/3  TypeScript"
hr
# next.config.mjs sets typescript.ignoreBuildErrors, so `next build` never surfaces
# these. Running tsc directly is the only way they are visible.
tsc_log="$(mktemp)"
./node_modules/.bin/tsc --noEmit > "$tsc_log" 2>&1
tsc_count="$(grep -c ': error TS' "$tsc_log" || true)"
ratchet "type errors" "$tsc_count" "$TYPECHECK_BASELINE_FILE" "$tsc_log"

echo
hr
echo "2/3  ESLint (excluding prettier formatting)"
hr
# eslint.ignoreDuringBuilds is also set in next.config.mjs. prettier/prettier
# violations are excluded here and handled by the format check below, because
# they number in the tens of thousands and would drown out real rule violations.
lint_log="$(mktemp)"
./node_modules/.bin/next lint --format compact > "$lint_log" 2>&1
lint_real_log="$(mktemp)"
grep -E ', (Error|Warning) - ' "$lint_log" | grep -v 'prettier/prettier' > "$lint_real_log" || true
lint_count="$(wc -l < "$lint_real_log" | tr -d '[:space:]')"
ratchet "lint problems" "$lint_count" "$LINT_BASELINE_FILE" "$lint_real_log"

echo
hr
echo "3/3  Formatting (changed files only)"
hr
if [ -z "${BASE_REF:-}" ]; then
  echo "SKIP: BASE_REF not set, so there is no diff to check."
  summary+=("SKIP  formatting: no BASE_REF")
else
  merge_base="$(git merge-base "$BASE_REF" HEAD 2>/dev/null || echo "$BASE_REF")"
  changed="$(git diff --name-only --diff-filter=ACMR "$merge_base"...HEAD \
    -- '*.ts' '*.tsx' '*.js' '*.jsx' '*.mjs' '*.json' '*.css' '*.scss' '*.md' || true)"

  if [ -z "$changed" ]; then
    echo "PASS: no formattable files changed against $BASE_REF."
    summary+=("PASS  formatting: no files to check")
  else
    file_count="$(printf '%s\n' "$changed" | wc -l | tr -d '[:space:]')"
    echo "Checking $file_count changed file(s) against $BASE_REF..."
    if printf '%s\n' "$changed" | xargs ./node_modules/.bin/prettier --check; then
      echo "PASS: all changed files are formatted."
      summary+=("PASS  formatting: $file_count file(s) clean")
    elif [ "${FORMAT_STRICT:-0}" = "1" ]; then
      echo
      echo "FAIL: the files listed above are not formatted. Fix with:"
      echo "        git diff --name-only $merge_base...HEAD | xargs pnpm exec prettier --write"
      summary+=("FAIL  formatting: changed files need prettier")
      failed=1
    else
      # Report-only until the one-time `pnpm format` sweep lands. The repo has
      # ~53k prettier violations, and evm-migration alone diverges from main by
      # hundreds of unformatted files — enforcing today would wall off the
      # migration merge rather than catch anything new. After the sweep, set
      # FORMAT_STRICT=1 in .github/workflows/ci.yml to make this blocking.
      echo
      echo "WARN: the files listed above are not formatted (not blocking yet)."
      echo "      Fix with:"
      echo "        git diff --name-only $merge_base...HEAD | xargs pnpm exec prettier --write"
      summary+=("WARN  formatting: changed files need prettier (report-only)")
    fi
  fi
fi

echo
hr
echo "SUMMARY"
hr
for line in "${summary[@]}"; do echo "  $line"; done
echo

if [ "$failed" -ne 0 ]; then
  echo "Quality gate FAILED."
  exit 1
fi
echo "Quality gate passed."
