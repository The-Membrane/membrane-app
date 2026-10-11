/**
 * S3 BENCHMARK — the cheapest same-stable borrow, per stable and size.
 *
 *   Bench(s, size) = min over eligible rows of the net borrow rate at that size.
 *
 * A row is eligible when, and only when:
 *   - it is Aave v3 Core or Prime (never `poolMeta == "Aave Horizon Market"`, a permissioned
 *     market), or SparkLend, or a LISTED Morpho market whose loan (`mintedCoin`) is the
 *     stable and whose collateral is WETH, wstETH, WBTC, cbBTC, weETH or rETH; and
 *   - at least $5M is borrowed. Idle and exotic-collateral markets print phantom "cheapest"
 *     rates ($0 borrowed at 0.06%, MWIN collateral at 1.38%); this rule drops them.
 *
 * The same rules bind an on-chain registry read: the registry also holds Euler vaults and
 * thin markets (Aave v3 USDS, ~$0.3M borrowed), which are rejected, not ranked.
 *
 * Rate per row:
 *   - ON-CHAIN where the net-APY registry already covers the market (Aave/Spark USDC, USDT,
 *     USDS, Aave USDe, the 4 Morpho markets): netBreakdown(b, {side:'borrow', sizeUsd}).net.apy
 *     (lib/netApy/breakdown.ts). A null at size — the borrow exceeds the venue's cash — is
 *     SKIPPED, never read as 0, and never replaced by that market's DeFiLlama rate.
 *   - otherwise DeFiLlama: apyBaseBorrow − apyRewardBorrow, labelled `reported`. For Aave v3
 *     and SparkLend, DeFiLlama's apyBaseBorrow is the APR (projects.json
 *     borrowRateIsAprProjects), so it goes through aprToApy first; Morpho's is an APY.
 *
 * Never falls back to another stable's rate: that would imply a swap.
 */

import { netBreakdown } from '../netApy/breakdown'
import { aprToApy } from '../netApy/fixedPoint'
import type { IncentiveCampaign } from '../netApy/incentives'
import type { VenueSnapshot } from '../netApy/types'
import type { VenueDef } from '../netApy/venues'
import { PROJECTS_CONFIG, STABLES_CONFIG, stableBySymbol, stableIndex } from './universe'
import {
  SCAN_SIZES_USD,
  SIZE_KEYS,
  sizeKeyOf,
  THRESHOLDS,
  type BenchmarkTable,
  type BenchRef,
  type LlamaLendBorrow,
  type LlamaPool,
  type MorphoMarketInfo,
  type ProjectsConfig,
  type SizeKey,
  type StablesConfig,
} from './types'

const lc = (s: string | null | undefined): string => String(s ?? '').toLowerCase()

export interface LlamaBenchRow {
  pool: string
  venue: string
  project: string
  poolMeta: string | null
  stable: string
  apy: number
  borrowUsd: number
  collateral: string | null
  ltv: number | null
}

export interface BenchRejection {
  pool: string
  venue: string
  reason: string
}

/** Morpho "listed" check: a listed market with this collateral, loan and LLTV exists. */
export function isListedMorpho(
  markets: readonly MorphoMarketInfo[],
  collateral: string,
  loanSymbol: string,
  ltv: number | null,
): boolean {
  return markets.some(
    (m) =>
      lc(m.collateralAddress) === lc(collateral) &&
      m.loanSymbol.toUpperCase() === loanSymbol.toUpperCase() &&
      (ltv === null || Math.abs(m.lltv - ltv) < 0.0005),
  )
}

function benchVenueLabel(p: LlamaPool, r: LlamaLendBorrow, b: ProjectsConfig['benchmark']): string {
  if (p.project === b.morphoProject && r.mintedCoin) {
    // On a Morpho row the pool symbol is the COLLATERAL.
    const lltv = r.ltv === null ? '' : ` ${Math.round(r.ltv * 1000) / 10}%`
    return `Morpho ${p.symbol}/${r.mintedCoin}${lltv}`
  }
  if (p.project === b.aaveV3Project)
    return `Aave v3${p.poolMeta ? ` ${p.poolMeta}` : ''} ${p.symbol}`
  if (p.project === b.sparkProject) return `SparkLend ${p.symbol}`
  return `${p.project} ${p.symbol}`
}

/** DeFiLlama borrow rows that are eligible benchmarks, plus every rejection with its reason. */
export function eligibleLlamaBench(
  pools: readonly LlamaPool[],
  lendBorrow: readonly LlamaLendBorrow[],
  morphoListed: readonly MorphoMarketInfo[],
  cfg: { stables?: StablesConfig; projects?: ProjectsConfig } = {},
): { eligible: LlamaBenchRow[]; rejected: BenchRejection[] } {
  const stablesCfg = cfg.stables ?? STABLES_CONFIG
  const stables = stableIndex(stablesCfg)
  const blueChip = new Set(stablesCfg.blueChipCollateral.map((c) => lc(c.address)))
  const b = (cfg.projects ?? PROJECTS_CONFIG).benchmark
  const poolById = new Map(pools.map((p) => [p.pool, p]))
  const eligible: LlamaBenchRow[] = []
  const rejected: BenchRejection[] = []

  for (const r of lendBorrow) {
    const p = poolById.get(r.pool)
    if (!p || p.chain !== 'Ethereum') continue
    const venue = benchVenueLabel(p, r, b)
    const reject = (reason: string) => rejected.push({ pool: r.pool, venue, reason })

    let stable: string | null = null
    let collateral: string | null = null
    if (p.project === b.aaveV3Project) {
      if (b.aaveV3DenyPoolMeta.includes(p.poolMeta ?? '')) {
        reject('permissioned market (Aave Horizon)')
        continue
      }
      if (!b.aaveV3PoolMeta.includes(p.poolMeta)) {
        reject(`Aave instance "${p.poolMeta}" is not Core or Prime`)
        continue
      }
    } else if (p.project === b.sparkProject) {
      // SparkLend reserves: one market per asset.
    } else if (p.project === b.morphoProject) {
      // THE MORPHO TRAP: symbol/underlying/tvl describe the collateral; the loan is mintedCoin.
      if (!r.mintedCoin) {
        reject('Morpho row without a loan asset (mintedCoin)')
        continue
      }
      collateral = (p.underlyingTokens ?? [])[0] ?? null
      if (!collateral || !blueChip.has(lc(collateral))) {
        reject('Morpho collateral is not blue-chip (WETH, wstETH, WBTC, cbBTC, weETH, rETH)')
        continue
      }
      if (!isListedMorpho(morphoListed, collateral, r.mintedCoin, r.ltv)) {
        reject('Morpho market not listed')
        continue
      }
    } else {
      continue
    }

    if (r.mintedCoin) {
      stable = stableBySymbol(r.mintedCoin, stablesCfg)?.symbol ?? null
    } else {
      const unders = p.underlyingTokens ?? []
      stable = unders.length === 1 ? (stables.get(lc(unders[0]))?.symbol ?? null) : null
    }
    if (!stable) {
      reject('loan asset is not a listed USD stable')
      continue
    }
    const borrowUsd = r.totalBorrowUsd ?? 0
    if (!(borrowUsd >= THRESHOLDS.minBenchBorrowUsd)) {
      reject(`under $5M borrowed ($${Math.round(borrowUsd).toLocaleString('en-US')})`)
      continue
    }
    if (
      r.apyBaseBorrow === null ||
      r.apyBaseBorrow === undefined ||
      !Number.isFinite(r.apyBaseBorrow)
    ) {
      reject('no borrow rate')
      continue
    }
    const base = r.apyBaseBorrow / 100
    const apy =
      ((b.borrowRateIsAprProjects ?? []).includes(p.project) ? aprToApy(base) : base) -
      (r.apyRewardBorrow ?? 0) / 100
    eligible.push({
      pool: r.pool,
      venue,
      project: p.project,
      poolMeta: p.poolMeta,
      stable,
      apy,
      borrowUsd,
      collateral,
      ltv: r.ltv,
    })
  }
  return { eligible, rejected }
}

export interface OnchainBenchVenue {
  venueKey: string
  label: string
  stable: string
  /** Net borrow APY at each size; null = not priced at that size (borrow > cash). */
  apyBySize: Record<SizeKey, number | null>
  borrowUsd: number
}

/** On-chain net borrow cost at each size for the registry venues that were read. */
export function onchainBench(
  snapshots: readonly VenueSnapshot[],
  campaigns: readonly IncentiveCampaign[],
  nowTs: number,
): OnchainBenchVenue[] {
  return snapshots.map((s) => {
    const apyBySize = {} as Record<SizeKey, number | null>
    for (const size of SCAN_SIZES_USD) {
      const b = netBreakdown(s, { side: 'borrow', sizeUsd: size, campaigns, nowTs })
      apyBySize[sizeKeyOf(size)] = b.net.apy
    }
    const st = s.state
    const debt =
      st.kind === 'aave-virtual'
        ? st.totalDebt
        : st.kind === 'spark'
          ? st.totalVariableDebt
          : st.kind === 'morpho-market'
            ? st.totalBorrowAssets
            : st.totalBorrows
    return {
      venueKey: s.venueKey,
      label: s.label,
      stable: s.asset.symbol,
      apyBySize,
      borrowUsd: Number(debt) / 10 ** s.asset.decimals,
    }
  })
}

/**
 * Which DeFiLlama row is the same market as a registry venue. Aave Core / Spark: same
 * project and asset. Morpho: same loan, collateral symbol and LLTV — and, because several
 * listed markets can share that triple, the borrowed USD within 5% of the on-chain read.
 */
export function registryVenueOf(
  row: LlamaBenchRow,
  defs: readonly VenueDef[],
  onchain: readonly OnchainBenchVenue[],
  stablesCfg: StablesConfig = STABLES_CONFIG,
): string | null {
  const blueSym = new Map(
    stablesCfg.blueChipCollateral.map((c) => [lc(c.address), c.symbol.toUpperCase()]),
  )
  for (const d of defs) {
    if (d.asset.symbol.toUpperCase() !== row.stable.toUpperCase()) continue
    if (d.protocol === 'aave-v3' && row.project === 'aave-v3' && row.poolMeta === null)
      return d.venueKey
    if (d.protocol === 'spark' && row.project === 'sparklend') return d.venueKey
    if (d.protocol === 'morpho-blue' && row.project === 'morpho-blue' && row.collateral) {
      if (blueSym.get(lc(row.collateral)) !== d.collateralSymbol.toUpperCase()) continue
      if (row.ltv === null || Math.abs(row.ltv - d.lltvPct / 100) > 0.0005) continue
      const on = onchain.find((o) => o.venueKey === d.venueKey)
      if (!on) return d.venueKey
      if (on.borrowUsd > 0 && Math.abs(row.borrowUsd - on.borrowUsd) / on.borrowUsd <= 0.05)
        return d.venueKey
    }
  }
  return null
}

/**
 * Why a registry venue read on-chain is not an eligible benchmark, or null when it is. The
 * DeFiLlama rules, applied to the read: Aave v3 Core (the registry's Aave pool) and SparkLend,
 * or a listed Morpho market with blue-chip collateral; and at least $5M borrowed. Without
 * `morphoListed` (unit fixtures) the listing check is skipped; the scan always passes it.
 */
export function onchainBenchRejection(
  o: OnchainBenchVenue,
  def: VenueDef | undefined,
  opts: { morphoListed?: readonly MorphoMarketInfo[]; stables?: StablesConfig } = {},
): string | null {
  if (!def) return 'not a registry venue'
  if (def.protocol === 'morpho-blue') {
    const blue = new Set(
      (opts.stables ?? STABLES_CONFIG).blueChipCollateral.map((c) => c.symbol.toUpperCase()),
    )
    if (!blue.has(def.collateralSymbol.toUpperCase()))
      return 'Morpho collateral is not blue-chip (WETH, wstETH, WBTC, cbBTC, weETH, rETH)'
    if (opts.morphoListed && !opts.morphoListed.some((m) => lc(m.marketId) === lc(def.marketId)))
      return 'Morpho market not listed'
  } else if (def.protocol !== 'aave-v3' && def.protocol !== 'spark') {
    return `${def.protocol} is not an eligible benchmark venue (Aave v3 Core/Prime, SparkLend, listed blue-chip Morpho)`
  }
  if (!(o.borrowUsd >= THRESHOLDS.minBenchBorrowUsd))
    return `under $5M borrowed ($${Math.round(o.borrowUsd).toLocaleString('en-US')})`
  return null
}

export interface BenchmarkResult {
  table: BenchmarkTable
  /** Gate-2 agreement per stable: on-chain min vs DeFiLlama min over the same markets. */
  agreement: Record<
    string,
    { onchain: number | null; defillama: number | null; diffPp: number | null }
  >
  rejected: BenchRejection[]
}

/**
 * Builds the per-stable table. `onchainVenues` are the registry venues read this run;
 * a DeFiLlama row for one of those markets is dropped (the on-chain read replaces it),
 * unless that venue failed to read. An on-chain read must pass onchainBenchRejection; a
 * rejected read still replaces its DeFiLlama row (the read is the truth about that market).
 */
export function buildBenchmarks(
  llama: { eligible: LlamaBenchRow[]; rejected: BenchRejection[] },
  onchainVenues: readonly OnchainBenchVenue[],
  defs: readonly VenueDef[],
  agreementStables: readonly string[],
  opts: { morphoListed?: readonly MorphoMarketInfo[]; stables?: StablesConfig } = {},
): BenchmarkResult {
  const table: BenchmarkTable = {}
  const ensure = (s: string) =>
    (table[s] ??= { bySize: { '100k': null, '1m': null, '10m': null }, candidates: [] })
  const readKeys = new Set(onchainVenues.map((o) => o.venueKey))
  const eligibleKeys = new Set<string>()
  // On-chain rejections first: the published audit sample keeps the first 60 rejections.
  const onchainRejected: BenchRejection[] = []
  const agreeOn: Record<string, number[]> = {}
  const agreeLl: Record<string, number[]> = {}

  for (const o of onchainVenues) {
    const why = onchainBenchRejection(
      o,
      defs.find((d) => d.venueKey === o.venueKey),
      opts,
    )
    if (why) {
      onchainRejected.push({ pool: `onchain:${o.venueKey}`, venue: o.label, reason: why })
      continue
    }
    eligibleKeys.add(o.venueKey)
    ensure(o.stable).candidates.push({
      venue: o.label,
      source: 'onchain',
      labelClass: 'projected',
      apyBySize: o.apyBySize,
      borrowUsd: o.borrowUsd,
    })
  }
  for (const r of llama.eligible) {
    const covered = registryVenueOf(r, defs, onchainVenues)
    const apyBySize = { '100k': r.apy, '1m': r.apy, '10m': r.apy }
    if (covered && readKeys.has(covered)) {
      if (agreementStables.includes(r.stable) && eligibleKeys.has(covered)) {
        const on = onchainVenues.find((o) => o.venueKey === covered)?.apyBySize['100k']
        if (on !== null && on !== undefined) {
          ;(agreeOn[r.stable] ??= []).push(on)
          ;(agreeLl[r.stable] ??= []).push(r.apy)
        }
      }
      continue
    }
    ensure(r.stable).candidates.push({
      venue: r.venue,
      source: 'defillama',
      labelClass: 'reported',
      apyBySize,
      borrowUsd: r.borrowUsd,
    })
  }

  for (const [stable, t] of Object.entries(table)) {
    for (const k of SIZE_KEYS) {
      let best: BenchRef | null = null
      for (const c of t.candidates) {
        const v = c.apyBySize[k]
        if (v === null || v === undefined || !Number.isFinite(v)) continue // a null at size is skipped, never 0
        if (!best || v < best.apy)
          best = { venue: c.venue, stable, apy: v, labelClass: c.labelClass, source: c.source }
      }
      t.bySize[k] = best
    }
  }

  const agreement: BenchmarkResult['agreement'] = {}
  for (const s of agreementStables) {
    const on = agreeOn[s]?.length ? Math.min(...agreeOn[s]) : null
    const ll = agreeLl[s]?.length ? Math.min(...agreeLl[s]) : null
    agreement[s] = {
      onchain: on,
      defillama: ll,
      diffPp: on !== null && ll !== null ? Math.abs(on - ll) * 100 : null,
    }
  }
  return { table, agreement, rejected: [...onchainRejected, ...llama.rejected] }
}
