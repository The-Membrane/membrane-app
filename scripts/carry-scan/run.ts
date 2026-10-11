// run.ts — one weekly carry-scout scan (umbrella product #10). docs/CARRY_SCOUT.md.
//
//   pnpm tsx scripts/carry-scan/run.ts --out <data-checkout>/carry-scan [--accept-churn]
//
// Runs S0–S8 (lib/carryScan/scan.ts) and writes the outcome (lib/carryScan/publish.ts):
//   published → latest.json + weeks/<week>.json + borrow-benchmarks/<week>.json + status.json, exit 0
//   held      → status.json only ({ok:false, held:true}), exit 2 — rerun with --accept-churn
//   failed    → status.json only ({ok:false, reason}), exit 1 — the last good latest.json stays live
//
// RPC: lib/netApy/rpc.ts netApyClient (NET_APY_RPC_URL first, env before .env.local, then
// public archive endpoints). Logs print the `env:<host>` label only; every error goes
// through redactError. Never imports scripts/lib/venue-reads.mjs (its readEnv throws
// without .env.local).

import { execFileSync } from 'child_process'

import { writeOutcome, readLatest, readPastWeeks } from '../../lib/carryScan/publish'
import { isoWeek, runCarryScan, type ScanOutcome } from '../../lib/carryScan/scan'
import { netApyClient, redactError } from '../../lib/netApy/rpc'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function appSha(): string | null {
  try {
    return (
      execFileSync('git', ['rev-parse', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null
    )
  } catch {
    return null
  }
}

async function main(): Promise<number> {
  const out = arg('--out')
  if (!out) {
    console.error('usage: tsx scripts/carry-scan/run.ts --out <dir> [--accept-churn]')
    return 1
  }
  const acceptChurn =
    process.argv.includes('--accept-churn') || process.env.CARRY_SCAN_ACCEPT_CHURN === 'true'
  const nowMs = Date.now()
  let outcome: ScanOutcome
  try {
    outcome = await runCarryScan({
      fetch: globalThis.fetch,
      rpc: netApyClient,
      nowMs: () => nowMs,
      appSha: appSha(),
      pastWeeks: readPastWeeks(out),
      lastLatest: readLatest(out),
      acceptChurn,
      log: (m) => console.log(`[carry-scan] ${m}`),
    })
  } catch (e) {
    outcome = { kind: 'failed', reason: `unexpected: ${redactError(e)}` }
  }
  const { code, status } = writeOutcome(out, outcome, nowMs, isoWeek(nowMs))
  if (outcome.kind === 'published') {
    const c = outcome.file.counts
    console.log(
      `[carry-scan] published ${outcome.file.week}: ranked=${c.ranked} lp=${c.rankedLp} no-benchmark=${outcome.file.rows.filter((r) => r.list === 'no-benchmark').length} unverified=${c.unverified} new=${c.new} dropped=${c.dropped}`,
    )
    if (outcome.note) console.log(`[carry-scan] note: ${outcome.note}`)
  } else {
    console.error(`[carry-scan] ${outcome.kind}: ${status.reason}`)
  }
  return code
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`[carry-scan] failed: ${redactError(e)}`)
    process.exit(1)
  },
)
