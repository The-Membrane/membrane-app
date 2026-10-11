/**
 * S1 UNIVERSE and S2 FILTERS — which DeFiLlama pools the scout looks at.
 *
 *   S1  chain = Ethereum ∧ stablecoin ∧ every underlying in ./stables.json (USD stables).
 *       exposure=single → the main list; exposure=multi ∧ ilRisk=no → the LP list.
 *       A Morpho MARKET row is dropped here: its symbol/underlying/TVL describe the
 *       collateral, and the loan is `mintedCoin` (the Morpho trap). The deposit side of a
 *       Morpho market is reached through its vaults, which are their own rows.
 *   S2  TVL ≥ $10M and > 0 · count ≥ 30 · not outlier · apy > 0 · reward share ≤ 50% ·
 *       category allowed · project not denied.
 *
 * APY headline is `apy`; the reward share comes from `apyReward` only, because on some
 * pools `apy` ≠ apyBase + apyReward (base or reward is null).
 *
 * Every pool that falls out records the FIRST gate it failed, keyed by its DeFiLlama UUID,
 * so a venue that passed last week can be listed as DROPPED with the reason.
 */

import PROJECTS from './projects.json'
import STABLES from './stables.json'
import {
  THRESHOLDS,
  type Candidate,
  type LlamaLendBorrow,
  type LlamaPool,
  type LlamaProtocol,
  type ProjectsConfig,
  type StableEntry,
  type StablesConfig,
} from './types'

export const STABLES_CONFIG = STABLES as StablesConfig
export const PROJECTS_CONFIG = PROJECTS as unknown as ProjectsConfig

const lc = (s: string | null | undefined): string => String(s ?? '').toLowerCase()

export function stableIndex(cfg: StablesConfig = STABLES_CONFIG): Map<string, StableEntry> {
  return new Map(cfg.stables.map((s) => [lc(s.address), s]))
}

export function stableBySymbol(
  symbol: string,
  cfg: StablesConfig = STABLES_CONFIG,
): StableEntry | null {
  const hits = cfg.stables.filter((s) => s.symbol.toUpperCase() === symbol.toUpperCase())
  return hits.length === 1 ? hits[0] : null
}

export type GateTrace = Map<string, string>

export interface UniverseResult {
  /** Ethereum ∧ stablecoin=true: the count gate 1 compares week over week. */
  ethStableCount: number
  single: Candidate[]
  lp: Candidate[]
  universeSingle: number
  universeLp: number
  trace: GateTrace
  traceCounts: Record<string, number>
}

/**
 * True when the joined /lendBorrow row says this pool is a market whose loan is not the
 * pool's own deposit token (a Morpho market: the row describes the collateral).
 */
export function isCollateralRow(
  p: LlamaPool,
  lb: LlamaLendBorrow | undefined,
  stables: Map<string, StableEntry>,
): boolean {
  if (!lb?.mintedCoin) return false
  const minted = lb.mintedCoin.toUpperCase()
  return !(p.underlyingTokens ?? []).some(
    (u) => stables.get(lc(u))?.symbol.toUpperCase() === minted,
  )
}

export function rewardShare(p: LlamaPool): number {
  const apy = p.apy ?? 0
  if (!(apy > 0)) return 0
  return Math.max(0, p.apyReward ?? 0) / apy
}

export function buildUniverse(
  pools: readonly LlamaPool[],
  lendBorrow: readonly LlamaLendBorrow[],
  protocols: readonly LlamaProtocol[],
  cfg: { stables?: StablesConfig; projects?: ProjectsConfig } = {},
): UniverseResult {
  const stables = stableIndex(cfg.stables ?? STABLES_CONFIG)
  const projects = cfg.projects ?? PROJECTS_CONFIG
  const lbByPool = new Map(lendBorrow.map((r) => [r.pool, r]))
  const categoryOf = new Map(protocols.map((p) => [p.slug, p.category]))
  const trace: GateTrace = new Map()
  const traceCounts: Record<string, number> = {}
  const fail = (p: LlamaPool, gate: string) => {
    trace.set(p.pool, gate)
    traceCounts[gate] = (traceCounts[gate] ?? 0) + 1
  }

  const eth = pools.filter((p) => p.chain === 'Ethereum' && p.stablecoin === true)
  const single: Candidate[] = []
  const lp: Candidate[] = []
  let universeSingle = 0
  let universeLp = 0

  for (const p of eth) {
    const unders = p.underlyingTokens ?? []
    if (!unders.length) {
      fail(p, 'universe: no underlying tokens')
      continue
    }
    if (isCollateralRow(p, lbByPool.get(p.pool), stables)) {
      fail(p, 'universe: market row describes collateral (loan is mintedCoin)')
      continue
    }
    const st = unders.map((u) => stables.get(lc(u)))
    if (st.some((s) => !s)) {
      fail(p, 'universe: an underlying is not a listed USD stable')
      continue
    }
    const isSingle = p.exposure === 'single'
    if (!isSingle && p.ilRisk !== 'no') {
      fail(p, 'universe: multi-asset with IL risk')
      continue
    }
    if (isSingle) universeSingle++
    else universeLp++

    // ---- S2
    const tvl = p.tvlUsd
    if (!(tvl > 0) || tvl < THRESHOLDS.minTvlUsd) {
      fail(p, 'filter: TVL under $10M')
      continue
    }
    if ((p.count ?? 0) < THRESHOLDS.minCount) {
      fail(p, 'filter: under 30 days of history')
      continue
    }
    if (p.outlier) {
      fail(p, 'filter: DeFiLlama outlier')
      continue
    }
    if (!((p.apy ?? 0) > 0)) {
      fail(p, 'filter: no yield')
      continue
    }
    if (rewardShare(p) > THRESHOLDS.maxRewardShare) {
      fail(p, 'filter: more than half the APY is rewards')
      continue
    }
    if (projects.projectDeny[p.project]) {
      fail(p, `filter: project denied (${projects.projectDeny[p.project]})`)
      continue
    }
    const category = categoryOf.get(p.project) ?? null
    const allow = isSingle ? projects.categoryAllow : projects.lpCategoryAllow
    if (!category || !allow.includes(category)) {
      fail(p, `filter: category ${category ?? 'unknown'} not allowed`)
      continue
    }
    const flag = category ? projects.categoryFlag[category] : undefined
    const c: Candidate = {
      pool: p,
      stables: st as StableEntry[],
      category,
      flags: flag ? [flag] : [],
      exposure: isSingle ? 'single' : 'multi',
    }
    ;(isSingle ? single : lp).push(c)
  }

  return { ethStableCount: eth.length, single, lp, universeSingle, universeLp, trace, traceCounts }
}

/** Display label for a pool: DeFiLlama symbol plus its pool meta. */
export const poolLabel = (p: LlamaPool): string =>
  p.poolMeta ? `${p.symbol} · ${p.poolMeta}` : p.symbol
