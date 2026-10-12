/**
 * RPC SCORECARD — per-endpoint rates from the ring's call ledger (`RpcCall` in
 * lib/position-sim/rpcRing.ts). Owner 2026-10-11: record "which RPC we are getting
 * things from so that we can evaluate them".
 *
 * Pure functions, so a ledger read from a JSONL file (scripts/audit-ring-gaps.mjs
 * --ledger) and one read from the corpus table `rpc_log_calls` (scripts/lib/rpc-ledger.mjs)
 * give the same numbers, and the published corpus cannot describe them a second way.
 *
 * A rate is only ever over answers that were CHECKED by a second endpoint. Under the
 * default verify 'empty' every empty answer is checked, but a non-empty one only when
 * spot-checked — so `shortRate` divides by checked non-empty answers, never by all of
 * them, and is null when there were none.
 */
import type { RpcCall } from './rpcRing'

export type LedgerRow = Pick<
  RpcCall,
  'host' | 'role' | 'outcome' | 'logs' | 'ms' | 'verdict' | 'contradicted' | 'fromBlock' | 'toBlock' | 'piece'
> & { run?: string }

export interface HostScore {
  host: string
  calls: number
  errors: number
  errorRate: number
  /** Calls that returned an answer (empty or not). */
  answers: number
  empty: number
  /** Empty answers a second endpoint checked (verdict agreed or recovered). */
  emptyChecked: number
  /** Empty answers another endpoint proved were missing logs. */
  falseEmpty: number
  /** falseEmpty / emptyChecked; null when nothing was checked. */
  falseEmptyRate: number | null
  /** Non-empty answers a second endpoint checked. */
  logsChecked: number
  /** Non-empty answers another endpoint proved were missing logs. */
  short: number
  /** short / logsChecked; null when nothing was checked. */
  shortRate: number | null
  /** Blocks of range answered. */
  blocks: number
  avgMs: number
  p95Ms: number
}

const CHECKED = new Set(['agreed', 'recovered'])

export function scorecard(rows: readonly LedgerRow[]): HostScore[] {
  const by = new Map<string, LedgerRow[]>()
  for (const r of rows) {
    const list = by.get(r.host)
    if (list) list.push(r)
    else by.set(r.host, [r])
  }
  const out: HostScore[] = []
  for (const [host, rs] of by) {
    const answers = rs.filter((r) => r.outcome !== 'error')
    const empties = answers.filter((r) => r.outcome === 'empty')
    const full = answers.filter((r) => r.outcome === 'logs')
    const emptyChecked = empties.filter((r) => CHECKED.has(r.verdict)).length
    const logsChecked = full.filter((r) => CHECKED.has(r.verdict)).length
    const falseEmpty = empties.filter((r) => r.contradicted).length
    const short = full.filter((r) => r.contradicted).length
    const ms = answers.map((r) => r.ms).sort((a, b) => a - b)
    out.push({
      host,
      calls: rs.length,
      errors: rs.length - answers.length,
      errorRate: rs.length ? (rs.length - answers.length) / rs.length : 0,
      answers: answers.length,
      empty: empties.length,
      emptyChecked,
      falseEmpty,
      falseEmptyRate: emptyChecked ? falseEmpty / emptyChecked : null,
      logsChecked,
      short,
      shortRate: logsChecked ? short / logsChecked : null,
      blocks: answers.reduce((s, r) => s + Number(BigInt(r.toBlock) - BigInt(r.fromBlock) + 1n), 0),
      avgMs: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : 0,
      p95Ms: ms.length ? ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))] : 0,
    })
  }
  return out.sort((a, b) => b.answers - a.answers || a.host.localeCompare(b.host))
}

/** Pieces by final verdict. A piece is one (run, piece) group of calls. */
export function pieceVerdicts(rows: readonly LedgerRow[]): Record<RpcCall['verdict'], number> {
  const seen = new Map<string, RpcCall['verdict']>()
  for (const r of rows) seen.set(`${r.run ?? ''}#${r.piece}`, r.verdict)
  const out: Record<RpcCall['verdict'], number> = { agreed: 0, recovered: 0, single: 0, unverified: 0, failed: 0 }
  for (const v of seen.values()) out[v]++
  return out
}

/** Distinct blocks inside the union of [from, to] ranges. */
export function coveredBlocks(ranges: readonly { fromBlock: bigint; toBlock: bigint }[]): bigint {
  const rs = [...ranges].sort((a, b) => (a.fromBlock < b.fromBlock ? -1 : a.fromBlock > b.fromBlock ? 1 : 0))
  let total = 0n
  let lo: bigint | null = null
  let hi = 0n
  for (const r of rs) {
    if (lo === null || r.fromBlock > hi + 1n) {
      if (lo !== null) total += hi - lo + 1n
      lo = r.fromBlock
      hi = r.toBlock
    } else if (r.toBlock > hi) hi = r.toBlock
  }
  if (lo !== null) total += hi - lo + 1n
  return total
}

const pct = (x: number | null) => (x === null ? '   —  ' : `${(x * 100).toFixed(1).padStart(5)}%`)
/** A fixed-width table for a terminal. Hosts only. */
export function formatScorecard(scores: readonly HostScore[]): string {
  const head = 'host                                   calls  err%  answers  empty  falseEmpty(rate)    short(rate)     avgMs  p95Ms'
  const lines = scores.map(
    (s) =>
      `${s.host.padEnd(38)} ${String(s.calls).padStart(5)} ${pct(s.errorRate)} ${String(s.answers).padStart(7)} ${String(s.empty).padStart(6)}` +
      `  ${`${s.falseEmpty}/${s.emptyChecked}`.padStart(8)} ${pct(s.falseEmptyRate)}  ${`${s.short}/${s.logsChecked}`.padStart(7)} ${pct(s.shortRate)}` +
      ` ${String(s.avgMs).padStart(6)} ${String(s.p95Ms).padStart(6)}`,
  )
  return [head, ...lines].join('\n')
}
