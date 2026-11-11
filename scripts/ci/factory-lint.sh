#!/usr/bin/env bash
#
# Factory lint: per-rule RATCHET over the mechanical rules in eslint-rules/
# (config: .eslintrc.factory.json; loop: docs/agent-workflows/LINT_RULE_PER_BUG.md).
#
# Counts violations per rule and compares each against .ci/factory-lint-baseline.json.
#   - any rule above its baseline  -> exit 1 (a new violation was introduced)
#   - any rule below its baseline  -> exit 0, but prints the number to write down
#   - a rule missing from baseline -> baseline 0 (new rules start strict)
#
# ESLint is found at node_modules/.bin/eslint, else $ESLINT_BIN (e.g. a scratch
# install). With $ESLINT_BIN, its node_modules is put on NODE_PATH so the parser
# resolves too. Usage:  pnpm lint:factory   |   ESLINT_BIN=/x/node_modules/.bin/eslint bash scripts/ci/factory-lint.sh
#
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

BASELINE=".ci/factory-lint-baseline.json"
DIRS=(components hooks services lib helpers pages)

if [ -x node_modules/.bin/eslint ]; then
  ESLINT=node_modules/.bin/eslint
elif [ -n "${ESLINT_BIN:-}" ] && [ -x "$ESLINT_BIN" ]; then
  ESLINT="$ESLINT_BIN"
  export NODE_PATH="$(cd "$(dirname "$ESLINT_BIN")/.." && pwd)${NODE_PATH:+:$NODE_PATH}"
else
  echo "factory-lint: eslint not found (node_modules/.bin/eslint missing and ESLINT_BIN unset)" >&2
  exit 2
fi

out="$(mktemp "${TMPDIR:-/tmp}/factory-lint.XXXXXX")"
trap 'rm -f "$out"' EXIT

start=$(date +%s)
"$ESLINT" --no-eslintrc -c .eslintrc.factory.json --rulesdir eslint-rules \
  --ext .ts,.tsx,.js,.jsx --format json --output-file "$out" "${DIRS[@]}"
rc=$?
elapsed=$(( $(date +%s) - start ))
if [ "$rc" -gt 1 ]; then
  echo "factory-lint: eslint crashed (exit $rc)" >&2
  exit 2
fi

node - "$out" "$BASELINE" "$elapsed" <<'NODE'
const fs = require('fs')
const [results, baselinePath, elapsed] = process.argv.slice(2)
const counts = {}
for (const file of JSON.parse(fs.readFileSync(results, 'utf8'))) {
  for (const m of file.messages) {
    // eslint-disable comments naming rules this config does not load (e.g. @typescript-eslint/*)
    // surface as "Definition for rule ... was not found" — not factory violations.
    if (/^Definition for rule .* was not found/.test(m.message)) continue
    const id = m.ruleId || '_parseErrors'
    counts[id] = (counts[id] || 0) + 1
  }
}
const baseline = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')) : {}
const rules = [...new Set([...Object.keys(baseline), ...Object.keys(counts)])].filter((r) => !r.startsWith('$')).sort()
let up = 0
let down = 0
console.log(`factory-lint (${elapsed}s)`)
console.log('rule'.padEnd(32) + 'count'.padStart(7) + 'baseline'.padStart(10))
for (const r of rules) {
  const c = counts[r] || 0
  const b = baseline[r] ?? 0
  let note = ''
  if (c > b) { note = '  FAIL: +' + (c - b) + ' new'; up++ }
  else if (c < b) { note = `  lower baseline to ${c}`; down++ }
  console.log(r.padEnd(32) + String(c).padStart(7) + String(b).padStart(10) + note)
}
if (up) {
  console.log(`\nFAIL: ${up} rule(s) above baseline. Fix the new violations (run eslint with the same flags to see them).`)
  process.exit(1)
}
if (down) console.log(`\nPASS — and ${down} rule(s) improved: lower them in ${baselinePath} in this PR (baselines only move down).`)
else console.log('\nPASS')
NODE
