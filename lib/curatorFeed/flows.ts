/**
 * Reallocation legs → daily flows, and the large withdrawals worth attributing. Pure.
 *
 * Allocator bots rebalance constantly (≈1.2k MetaMorpho reallocation legs a day on
 * 2026-10-07), so legs are stored as one row per (UTC day, vault, target, source) and
 * only withdrawals above a size threshold are kept one by one, grouped per
 * (market, block) for attribution.
 */

import type { FlowRow, FlowsFile } from './store'
import { SCHEMA } from './store'
import type { AttributionCase, DailyFlow, FlowSource, Reallocation } from './types'

export const utcDay = (ts: number): string => new Date(ts * 1000).toISOString().slice(0, 10)

export function aggregateDaily(legs: Reallocation[]): DailyFlow[] {
  const m = new Map<string, { row: DailyFlow; out: bigint; in: bigint }>()
  for (const l of legs) {
    const day = utcDay(l.ts)
    const key = `${day}|${l.vault}|${l.target}|${l.source}`
    let cur = m.get(key)
    if (!cur) {
      cur = {
        row: { day, vault: l.vault, target: l.target, source: l.source, out: '0', in: '0', n: 0 },
        out: 0n,
        in: 0n,
      }
      m.set(key, cur)
    }
    if (l.dir === 'out') cur.out += l.assets
    else cur.in += l.assets
    cur.row.n++
  }
  return [...m.values()]
    .map(({ row, out, in: inn }) => ({ ...row, out: out.toString(), in: inn.toString() }))
    .sort(
      (a, b) =>
        a.day.localeCompare(b.day) ||
        a.vault.localeCompare(b.vault) ||
        a.target.localeCompare(b.target),
    )
}

/**
 * Within one transaction an allocator usually withdraws from A and supplies to B; the
 * idle market is often both. Net per (tx, vault, target) so a withdraw-then-resupply of
 * the same market inside one call is not counted as a drain.
 */
export function netPerTx(legs: Reallocation[]): Reallocation[] {
  const m = new Map<string, Reallocation & { net: bigint }>()
  for (const l of legs) {
    const key = `${l.tx}|${l.vault}|${l.target}`
    const signed = l.dir === 'out' ? -l.assets : l.assets
    const cur = m.get(key)
    if (cur) cur.net += signed
    else m.set(key, { ...l, net: signed })
  }
  return [...m.values()]
    .filter((x) => x.net !== 0n)
    .map(({ net, ...l }) => ({
      ...l,
      dir: net < 0n ? ('out' as const) : ('in' as const),
      assets: net < 0n ? -net : net,
    }))
}

/**
 * Net withdrawals at or above `minUsd` (priced by `usdOf`, collection-time prices),
 * from Morpho Blue markets only (`isMorphoMarket`), grouped by (market, block). Every
 * leg in a selected block is kept, large or not, so the block's total is honest.
 */
export function selectLargeWithdrawals(
  legs: Reallocation[],
  usdOf: (l: Reallocation) => number | undefined,
  isMorphoMarket: (target: string) => boolean,
  minUsd: number,
): AttributionCase[] {
  const net = netPerTx(legs).filter((l) => l.dir === 'out' && isMorphoMarket(l.target))
  const hit = new Set(
    net.filter((l) => (usdOf(l) ?? 0) >= minUsd).map((l) => `${l.target}|${l.block}`),
  )
  const cases = new Map<string, AttributionCase>()
  for (const l of net) {
    const key = `${l.target}|${l.block}`
    if (!hit.has(key)) continue
    let c = cases.get(key)
    if (!c) {
      c = { market: l.target, block: l.block, ts: l.ts, legs: [] }
      cases.set(key, c)
    }
    c.legs.push({ vault: l.vault, assets: l.assets.toString(), source: l.source, tx: l.tx })
  }
  return [...cases.values()].sort((a, b) => a.block - b.block)
}

// ── compact storage ────────────────────────────────────────────────────────────

/** Base units → whole units, 6 significant digits (display precision, stated in meta). */
export function toUnits6(base: string | bigint, decimals: number): number {
  const v = Number(BigInt(base)) / 10 ** decimals
  return v === 0 ? 0 : Number(v.toPrecision(6))
}

export function encodeFlows(
  flows: DailyFlow[],
  toBlock: number,
  decimalsOf: (vault: string) => number,
): FlowsFile {
  const dict = () => {
    const list: string[] = []
    const idx = new Map<string, number>()
    return {
      list,
      at(k: string): number {
        let i = idx.get(k)
        if (i === undefined) {
          i = list.length
          list.push(k)
          idx.set(k, i)
        }
        return i
      },
    }
  }
  const days = dict()
  const vaults = dict()
  const targets = dict()
  const rows: FlowRow[] = flows.map((f) => {
    const d = decimalsOf(f.vault)
    return [
      days.at(f.day),
      vaults.at(f.vault),
      targets.at(f.target),
      f.source === 'public-allocator' ? 1 : 0,
      toUnits6(f.out, d),
      toUnits6(f.in, d),
      f.n,
    ]
  })
  return {
    schema: SCHEMA,
    toBlock,
    days: days.list,
    vaults: vaults.list,
    targets: targets.list,
    rows,
  }
}

export interface UnitFlow {
  day: string
  vault: string
  target: string
  source: FlowSource
  /** Whole loan-token units. */
  out: number
  in: number
  n: number
}

export const decodeFlows = (f: FlowsFile): UnitFlow[] =>
  f.rows.map(([d, v, t, s, out, inn, n]) => ({
    day: f.days[d],
    vault: f.vaults[v],
    target: f.targets[t],
    source: s === 1 ? 'public-allocator' : 'allocator',
    out,
    in: inn,
    n,
  }))
