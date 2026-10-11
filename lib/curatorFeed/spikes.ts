/**
 * Spike-first attribution: borrow-rate jumps on Morpho Blue markets, and who moved the
 * market in the block that caused each one. Pure.
 *
 * WHERE THE RATE COMES FROM. Morpho Blue emits AccrueInterest(id, prevBorrowRate, …) on
 * the first interaction with a market in a block (no event when no time has passed).
 * `prevBorrowRate` is the per-second WAD rate the IRM charged since the previous accrual —
 * set by the market's state after the LAST interaction of the previous accrual's block.
 * So for consecutive accruals i−1 (block c) and i: the rate moved from r(i−1) to r(i)
 * because of what happened in block c. That block is where the drivers are read.
 *
 * WHAT A DRIVER IS. Every Morpho Blue Supply / Withdraw / Borrow / Repay / Liquidate on the
 * market in block c, grouped (types.ts SpikeDriver). A Withdraw on behalf of a vault (or a
 * Vault V2 adapter) is a REALLOCATION when the same transaction holds an allocator
 * reallocation leg for that vault and market, else a REDEMPTION (the vault paying its own
 * depositors). Non-vault suppliers are "supplier-*".
 *
 * WHO DROVE IT. Utilization u = B / S. A flow's share of the move is its first-order effect
 * at the state before the block: a supply change ΔS moves u by −B·ΔS / S², a borrow change
 * ΔB by ΔB / S. Shares are among the flows that pushed u UP, and are labelled approximate
 * ("≈") wherever shown: interest accrued in the block and second-order terms are left out.
 */

import { aprOf, ratio, type SpikeThresholds, DEFAULT_SPIKE } from './attribution'
import type { FlowSource, SpikeCase, SpikeDriver, SpikeFlow } from './types'

export interface RatePoint {
  block: number
  logIndex: number
  /** Per-second WAD rate from AccrueInterest.prevBorrowRate. */
  rate: bigint
}

export interface SpikeCandidate {
  market: string
  /** The block whose interactions set the new rate (accrual i−1). */
  block: number
  /** The accrual that revealed it (accrual i). */
  seenAt: number
  rateBefore: bigint
  rateAfter: bigint
}

/** A rate jump: after ≥ ratio × before AND after − before ≥ minDeltaApr (APR, simple). */
export function isSpike(
  before: bigint,
  after: bigint,
  t: SpikeThresholds = DEFAULT_SPIKE,
): boolean {
  const a0 = aprOf(before)
  const a1 = aprOf(after)
  return a1 >= t.ratio * a0 && a1 - a0 >= t.minDeltaApr
}

/**
 * Scan one market's accruals (any order) for jumps. `prev` is the last accrual before
 * `points` (from an earlier run), so a jump across the run boundary is not lost.
 */
export function detectSpikes(
  market: string,
  points: RatePoint[],
  prev?: { block: number; rate: bigint },
  t: SpikeThresholds = DEFAULT_SPIKE,
): SpikeCandidate[] {
  const xs = [...points].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)
  const out: SpikeCandidate[] = []
  let last = prev
  for (const p of xs) {
    if (last && p.block > last.block && isSpike(last.rate, p.rate, t)) {
      // last.rate applied before block `last.block`'s interactions; p.rate after them.
      out.push({
        market,
        block: last.block,
        seenAt: p.block,
        rateBefore: last.rate,
        rateAfter: p.rate,
      })
    }
    if (!last || p.block >= last.block) last = { block: p.block, rate: p.rate }
  }
  return out
}

// ── flows in the cause block ───────────────────────────────────────────────────

/** A decoded Morpho Blue flow log in the cause block (collector → here). */
export interface BlueFlowLog {
  name: 'Supply' | 'Withdraw' | 'Borrow' | 'Repay' | 'Liquidate'
  tx: string
  onBehalf?: string
  assets?: bigint
  repaidAssets?: bigint
  badDebtAssets?: bigint
}

export interface FlowContext {
  /** Vault behind a Morpho position owner: a vault itself, or a Vault V2 adapter → its vault. */
  vaultOf(onBehalf: string): string | undefined
  /** The allocator leg source when tx moved this vault out of this market, else undefined. */
  reallocationIn(tx: string, vault: string): FlowSource | undefined
}

/** Group a block's flow logs into SpikeFlow rows (summed per driver, side, vault, source). */
export function groupFlows(logs: BlueFlowLog[], ctx: FlowContext): SpikeFlow[] {
  const rows = new Map<string, SpikeFlow & { sum: bigint }>()
  const add = (
    driver: SpikeDriver,
    side: 'supply' | 'borrow',
    sign: 1 | -1,
    assets: bigint | undefined,
    tx: string,
    vault?: string,
    source?: FlowSource,
  ) => {
    if (!assets || assets === 0n) return
    const key = `${driver}|${side}|${sign}|${vault ?? ''}|${source ?? ''}`
    const cur = rows.get(key)
    if (cur) {
      cur.sum += assets
      cur.n++
    } else rows.set(key, { driver, side, sign, assets: '0', vault, source, tx, n: 1, sum: assets })
  }
  for (const l of logs) {
    const vault = l.onBehalf ? ctx.vaultOf(l.onBehalf) : undefined
    switch (l.name) {
      case 'Supply':
        add(vault ? 'vault-deposit' : 'supplier-deposit', 'supply', 1, l.assets, l.tx, vault)
        break
      case 'Withdraw': {
        if (!vault) {
          add('supplier-withdrawal', 'supply', -1, l.assets, l.tx)
          break
        }
        const source = ctx.reallocationIn(l.tx, vault)
        add(
          source ? 'vault-reallocation' : 'vault-redemption',
          'supply',
          -1,
          l.assets,
          l.tx,
          vault,
          source,
        )
        break
      }
      case 'Borrow':
        add('borrow', 'borrow', 1, l.assets, l.tx)
        break
      case 'Repay':
        add('repay', 'borrow', -1, l.assets, l.tx)
        break
      case 'Liquidate':
        add('liquidation', 'borrow', -1, l.repaidAssets, l.tx)
        add('bad-debt', 'borrow', -1, l.badDebtAssets, l.tx)
        add('bad-debt', 'supply', -1, l.badDebtAssets, l.tx)
        break
    }
  }
  return [...rows.values()]
    .map(({ sum, ...r }) => ({ ...r, assets: sum.toString() }))
    .sort((a, b) =>
      BigInt(b.assets) > BigInt(a.assets) ? 1 : BigInt(b.assets) < BigInt(a.assets) ? -1 : 0,
    )
}

// ── explanation ────────────────────────────────────────────────────────────────

export interface Contribution extends SpikeFlow {
  /** First-order change in utilization from this flow (+ = pushed utilization up). */
  du: number
  /** Share of the upward push (0–1), among flows with du > 0. */
  share: number
}

export interface SpikeExplanation {
  market: string
  block: number
  ts: number
  aprBefore: number
  aprAfter: number
  utilBefore?: number
  utilAfter?: number
  supplyBefore?: bigint
  borrowBefore?: bigint
  contributions: Contribution[]
  /** The driver group with the largest upward push, when there was any. */
  top?: SpikeDriver
  /** Its share of the upward push (0–1). */
  topShare?: number
  /** Vault reallocations' combined share of the upward push (0–1). */
  reallocationShare: number
}

export function explainSpike(c: SpikeCase): SpikeExplanation {
  const S = c.before ? BigInt(c.before.totalSupplyAssets) : undefined
  const B = c.before ? BigInt(c.before.totalBorrowAssets) : undefined
  const base = {
    market: c.market,
    block: c.block,
    ts: c.ts,
    aprBefore: aprOf(BigInt(c.rateBefore)),
    aprAfter: aprOf(BigInt(c.rateAfter)),
    utilBefore: c.before ? ratio(B!, S!) : undefined,
    utilAfter: c.after
      ? ratio(BigInt(c.after.totalBorrowAssets), BigInt(c.after.totalSupplyAssets))
      : undefined,
    supplyBefore: S,
    borrowBefore: B,
  }
  if (S === undefined || B === undefined || S === 0n) {
    return {
      ...base,
      contributions: c.flows.map((f) => ({ ...f, du: 0, share: 0 })),
      reallocationShare: 0,
    }
  }
  // du in utilization units, computed at 1e-9 resolution in bigint before converting.
  const SCALE = 1_000_000_000n
  const contributions = c.flows.map((f) => {
    const signed = BigInt(f.sign) * BigInt(f.assets)
    const du =
      f.side === 'supply'
        ? -Number((B * signed * SCALE) / (S * S)) / 1e9
        : Number((signed * SCALE) / S) / 1e9
    return { ...f, du, share: 0 }
  })
  const up = contributions.filter((x) => x.du > 0).reduce((s, x) => s + x.du, 0)
  for (const x of contributions) x.share = up > 0 && x.du > 0 ? x.du / up : 0
  const byDriver = new Map<SpikeDriver, number>()
  for (const x of contributions) byDriver.set(x.driver, (byDriver.get(x.driver) ?? 0) + x.share)
  const top = [...byDriver.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])[0]
  return {
    ...base,
    contributions: contributions.sort((a, b) => b.du - a.du),
    top: top?.[0],
    topShare: top?.[1],
    reallocationShare: byDriver.get('vault-reallocation') ?? 0,
  }
}
