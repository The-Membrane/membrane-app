/**
 * S8 THE PUBLISH GATE — fail closed. On any hard failure the run writes ONLY status.json
 * ({ok:false, reason}) and exits non-zero; the previous latest.json stays live and the page
 * says so. Checks (docs/CARRY_SCOUT.md §6):
 *
 *   1  every source answered 200 and passed its schema check (sources.ts throws otherwise);
 *      the /pools Ethereum stablecoin count is within ±30% of last week's (1,313 on 2026-10-10).
 *   2  USDC, USDT, USDS and DAI each have an eligible benchmark; where both exist, the
 *      on-chain and DeFiLlama benchmarks for USDC and USDT agree within 0.5pp.
 *   3  the finalized anchor resolves, and at least 50% of the finalists that were checked
 *      on-chain verify. Below that the RPC problem is systemic; above it, single failures
 *      go to the Unverified list.
 *   4  churn: NEW > 15, or the ranked count moving more than 50% week over week, HOLDS the
 *      result until a workflow_dispatch run with accept_churn=true.
 *   5  the carryScan unit tests pass (the workflow step before this script).
 */

import { AGREEMENT_STABLES, REQUIRED_BENCH_STABLES, THRESHOLDS, type BenchmarkTable } from './types'

export type GateCheck = { ok: true } | { ok: false; reason: string }

export function checkUniverseCount(count: number, lastCount: number | null): GateCheck {
  const base = lastCount ?? THRESHOLDS.universeBaselineCount
  const drift = Math.abs(count - base) / base
  return drift <= THRESHOLDS.universeCountTolerance
    ? { ok: true }
    : {
        ok: false,
        reason: `gate 1: /pools has ${count} Ethereum stablecoin pools vs ${base} last week (${Math.round(drift * 100)}% > 30%)`,
      }
}

export function checkBenchmarks(
  table: BenchmarkTable,
  agreement: Record<string, { diffPp: number | null }>,
): GateCheck {
  const missing = REQUIRED_BENCH_STABLES.filter((s) => !table[s]?.bySize['100k'])
  if (missing.length)
    return { ok: false, reason: `gate 2: no eligible borrow benchmark for ${missing.join(', ')}` }
  for (const s of AGREEMENT_STABLES) {
    const d = agreement[s]?.diffPp
    if (d !== null && d !== undefined && d > THRESHOLDS.benchAgreementPp) {
      return {
        ok: false,
        reason: `gate 2: ${s} on-chain and DeFiLlama benchmarks differ by ${d.toFixed(2)}pp (> ${THRESHOLDS.benchAgreementPp}pp)`,
      }
    }
  }
  return { ok: true }
}

/**
 * `attempted` = finalists with a resolved address. With finalists but not one address,
 * resolution itself broke (the Morpho list, the hand-kept map, the Aave reads): fail closed
 * rather than publish a page of Unverified rows.
 */
export function checkVerification(attempted: number, verified: number, finalists = 0): GateCheck {
  if (attempted === 0)
    return finalists > 0
      ? { ok: false, reason: `gate 3: none of ${finalists} finalists resolved to an address` }
      : { ok: true }
  const share = verified / attempted
  return share >= THRESHOLDS.minVerifiedShare
    ? { ok: true }
    : {
        ok: false,
        reason: `gate 3: only ${verified} of ${attempted} finalists verified on-chain (< 50%): systemic RPC failure`,
      }
}

/**
 * `lastRanked` null = no previous weekly file: the baseline run, where every row is NEW by
 * definition, so neither churn test applies.
 */
export function checkChurn(
  newCount: number,
  ranked: number,
  lastRanked: number | null,
  acceptChurn: boolean,
): { held: boolean; reason: string | null } {
  const reasons: string[] = []
  if (lastRanked !== null && newCount > THRESHOLDS.maxNew)
    reasons.push(`${newCount} NEW rows (> ${THRESHOLDS.maxNew})`)
  if (lastRanked !== null && lastRanked > 0) {
    const swing = Math.abs(ranked - lastRanked) / lastRanked
    if (swing > THRESHOLDS.maxRankedSwing)
      reasons.push(`ranked count ${lastRanked} → ${ranked} (${Math.round(swing * 100)}% > 50%)`)
  }
  if (!reasons.length) return { held: false, reason: null }
  const reason = `gate 4 (churn): ${reasons.join('; ')}`
  return acceptChurn
    ? { held: false, reason: `${reason} — accepted by accept_churn` }
    : { held: true, reason }
}
