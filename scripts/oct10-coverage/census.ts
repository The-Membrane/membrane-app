/**
 * The Oct 10-11 2025 FULL-COVERAGE census, as a pure function of the on-chain pull: every
 * liquidated Aave V3 account and Morpho Blue position, the protocol's real liquidations on
 * the one side, Membrane's engine walked minute by minute on the other, on the same positions.
 *
 * build-census.ts loads the files and writes the outputs; this module only computes, so the
 * unit tests can run it on a committed fixture subset (tests/unit/fixtures/wavefront-census-
 * fixture.json) and scripts/tests/wavefront-census.test.ts on the whole pull.
 *
 * SCOPE: every Aave V3 pool in each chain's PoolAddressesProviderRegistry (mainnet Core, Lido,
 * EtherFi; Arbitrum, Optimism, Base Core) and every Morpho Blue singleton, on mainnet, Arbitrum,
 * Optimism and Base — the owner's CSVs plus the on-chain extras the pull found
 * (recall-coverage/inputs/oct10/onchain/events-scan.json).
 *
 * Method (docs/WAVEFRONT.md has the long form):
 *   - position spec: lib/wavefront/aave.ts, lib/wavefront/morpho.ts (composition at the t0
 *     event's N-1, valued at the t0 oracle prices — block N, or N-1 where N does not show the
 *     breach the protocol liquidated; line, LTV0, delay class, mixed split);
 *   - Membrane: lib/wavefront/kernel.ts per half, stepped over every minute after t0 to the
 *     grid end, each leg moved by its own protocol-oracle minute path relative to its t0 price
 *     (the path is the price in force at each minute START — no look-ahead);
 *   - real: every event in USD at block-N protocol-oracle prices (Aave seized includes the
 *     liquidation protocol fee);
 *   - one stream (lib/wavefront/stream.ts) for the whole window, ticks folded by its reducer.
 *
 * NO SILENT GAPS. A held leg with no price at a minute the walk reads is a hard error here
 * (`priceAt` and the kernel's default): this pull has no gap anywhere, and a frozen price must
 * never pass for a calm market. A token with no USD path AT ALL (some Morpho loan tokens) is
 * different — it is unpriced by design, counted, and its USD is null on both sides.
 */

import { heldAtOne } from '../../lib/position-sim/collateralClass'
import {
  BORROW_LTV_GAP,
  CURE_WINDOW_SECONDS,
  LIQ_DEBT_MINIMUM_USD,
  MAX_THRESHOLD_TO_DELAY,
} from '../../lib/position-sim/membrane'
import {
  aavePoolOf,
  aavePositionSpec,
  aaveRealUsd,
  aaveSpecAt,
  kernelLegs,
  minuteOf,
  pathAnchors,
  sortEvents,
  streamLegs,
  t0Decision,
  type AaveCsvRow,
  type AaveEventRecord,
  type AaveFeeRecord,
  type HalfSpec,
  type PositionSpec,
  type PriceBasis,
  type PriceSource,
  type T0Decision,
} from '../../lib/wavefront/aave'
import { clusterAssigner, primarySymbol } from '../../lib/wavefront/cluster'
import { MembraneKernel, type KernelLeg, type KernelResult } from '../../lib/wavefront/kernel'
import {
  CAPACITY_MULTIPLIER,
  LiquidityBook,
  researchClassMultiplier,
  researchMedianMultiplier,
  computeCapacity,
  liqKeyOf,
  type CapacityEntry,
  type CapacityEvent,
  type KernelLiquidity,
} from '../../lib/wavefront/liquidity'
import {
  membraneDebtScale,
  membraneLinePlan,
  scaledHalves,
  type MembraneLinePlan,
} from '../../lib/wavefront/membraneLine'
import {
  morphoPositionSpec,
  morphoRealUsd,
  morphoSpecAt,
  type MorphoCsvRow,
  type MorphoEventRecord,
} from '../../lib/wavefront/morpho'
import { AAVE_CORE_POOL, aavePid, morphoPid } from '../../lib/wavefront/pid'
import {
  KIND_RANK,
  TICK_EVERY_MINUTES,
  applyRecord,
  createReplayState,
  isTickMinute,
  roundRecord,
  tickFromState,
  type DelayClass,
  type MemRecord,
  type OpenRecord,
  type RealRecord,
  type StreamRecord,
  type StreamWindow,
  type Totals,
} from '../../lib/wavefront/stream'
import type { CureOutcome } from '../../lib/position-sim/curePath'

export const MAX_SALES = 20
export const DELAY_STEPS = Math.ceil(CURE_WINDOW_SECONDS / 60)

/**
 * AaveOracle minute path of one market (aave-oracle-1m.<chain>[.<market>].json.gz, the fields
 * read). Keyed in CensusInputs by `${chain}:${pool}`.
 */
export interface AaveOracleFile {
  chain: string
  pool: string
  baseUnit: string
  assets: { address: string; symbol: string; decimals: number }[]
  prices: Record<string, (string | null)[]>
}
/** Morpho oracle minute path of one chain (morpho-oracle-1m.<chain>.json.gz, the fields read). */
export interface MorphoOracleFile {
  chain: string
  prices: Record<string, (string | null)[]>
}

export interface CensusInputs {
  window: StreamWindow
  /** The owner's CSV rows (all core) and the _extra.csv rows (which carry `market`). */
  aaveCsv: AaveCsvRow[]
  /** aave-events + aave-events-extra (the extra records carry `market`). */
  aaveEvents: AaveEventRecord[]
  /** aave-protocol-fee: one record per Aave event. */
  aaveFees: AaveFeeRecord[]
  /** Keyed `${chain}:${pool}`. */
  aaveOracle: Record<string, AaveOracleFile>
  morphoCsv: (MorphoCsvRow & Record<string, unknown>)[]
  morphoEvents: MorphoEventRecord[]
  /** Keyed by chain. */
  morphoOracle: Record<string, MorphoOracleFile>
}

export interface CensusOptions {
  /** SENSITIVITY ONLY: stop after a delayed sale at t0 past the band (the old cureWalk). */
  stopAfterT0BandSale?: boolean
  /**
   * SENSITIVITY ONLY: the price bases tried when locating t0. Default ['N', 'N-1'];
   * ['N-1', 'N'] values every position the N-1 prices locate at N-1.
   */
  basisOrder?: readonly PriceBasis[]
  /** Build only these positions (the cross-check's overlap set). */
  onlyPids?: ReadonlySet<string>
  /**
   * CROSS-CHECK TOGGLES ONLY. Rewrite a walked position's spec before its kernels are built
   * (e.g. the old census's single liquidated leg, or its inverted-HF line).
   */
  specOverride?: (
    spec: PositionSpec,
    events: readonly (AaveEventRecord | MorphoEventRecord)[],
  ) => PositionSpec
  /**
   * CROSS-CHECK TOGGLES ONLY. A leg's ratio at a minute from another price source; undefined
   * falls through to the protocol path.
   */
  ratioOverride?: (spec: PositionSpec, leg: KernelLeg, minute: number) => number | null | undefined
  /**
   * SENSITIVITY ONLY (scripts/build-evidence-census.ts): the kernel parameters the headline
   * takes from lib/position-sim/membrane.ts. Unset, every one is the headline's value, and the
   * census is byte-for-byte the one build-census.ts writes. The rows' t0Decisions stay at the
   * headline band either way.
   */
  band?: number
  /** SENSITIVITY ONLY: nobody calls the permissionless early clear (DelayTimer noEarlyClear). */
  noEarlyClear?: boolean
  /** SENSITIVITY ONLY: the liqDebtMinimum floor is not applied (debtMinimum 0). */
  noDebtFloor?: boolean
  /** SENSITIVITY ONLY: the cap on sales per position (MAX_SALES). */
  maxSales?: number
  /**
   * THE LINE Membrane walks each position at. 'membrane' (the headline, owner ruling
   * 2026-10-18): Membrane's own per-asset line, lib/wavefront/membraneLine.ts — a position with
   * no Membrane line on any leg is excluded ('no-membrane-line'). 'protocol': the protocol's
   * own line (Aave's weighted LT, Morpho's LLTV) — the published sensitivity and the
   * pre-2026-10-18 census.
   */
  lineMode?: 'membrane' | 'protocol'
  /**
   * SENSITIVITY ONLY: keep positions where SOME collateral legs have no Membrane line, those
   * legs left out of the weighted line (the simulator's rule; the 2026-10-18 first-round
   * headline). The headline excludes every such position ('partial-membrane-line', owner
   * ruling 2026-10-18, second round).
   */
  allowPartialLines?: boolean
  /**
   * SENSITIVITY ONLY: walk at Membrane's line WITHOUT sizing the debt to it (the first-round
   * method). The headline scales each half's t0 debt by memLine / protocolLine
   * (lib/wavefront/membraneLine.ts membraneDebtScale).
   */
  noDebtScaling?: boolean
  /**
   * The liquidity cap (lib/wavefront/liquidity.ts): every Membrane sale draws on the shared
   * book at `capacityMultiplier` x the measured capacity. Default CAPACITY_MULTIPLIER (0.98, the
   * headline); Infinity = unlimited, on the SAME positions (a no-capacity holding is still
   * excluded). 'research-per-class' / 'research-medians': the research class
   * table's recommended / measured-median multipliers (liquidity.ts RESEARCH_LIQUIDITY_CLASSES),
   * sensitivities. Default CAPACITY_MULTIPLIER (0.98x).
   */
  capacityMultiplier?: number | 'research-per-class' | 'research-medians'
  /**
   * REGRESSION AND CROSS-CHECK ONLY: no liquidity model at all — no book, no no-capacity
   * exclusion. With lineMode 'protocol' this is the pre-2026-10-18 census, row for row.
   */
  noCapacityModel?: boolean
  /** The capacity table to use instead of the one measured from these inputs (fixtures). */
  capacity?: CapacityEntry[]
  /**
   * ANALYSIS ONLY. Called once per walked position after its walk, with its spec, each half's
   * kernel result, and the protocol path it was walked on: `ratioAt(leg, minute)` is the leg's
   * price in force at that minute's start over its t0 price (1 for a leg with no key). It reads
   * the same columns and throws on the same gaps as the walk. It never changes a row.
   */
  probe?: (p: CensusProbe) => void
}

/** What `CensusOptions.probe` is handed for one walked position. */
export interface CensusProbe {
  spec: PositionSpec
  /** The halves walked (Membrane's line in the headline; the spec's own in 'protocol' mode). */
  halves: readonly HalfSpec[]
  /** The whole position's line walked, and its class on that line. */
  line: number
  /** Membrane's t0 debt over the real t0 debt (1 unscaled). */
  debtScale: number
  delayClass: DelayClass
  results: readonly KernelResult[]
  ratioAt: (leg: KernelLeg, minute: number) => number
  usdPerUnit: (minute: number) => number | null
  lastMinute: number
}

export interface SubRow {
  sub: number
  delayClass: 'no-delay' | 'delayed'
  line: number
  share: number
  symbols: string[]
  outcome: CureOutcome
  sales: number
  closedT0: number
  repaidUsd: number | null
  startUnbreached: boolean
  armedAtGridEnd: boolean
}

/** Why a walked position is left out of a run's comparison (both sides). */
export type ExclusionReason = 'no-membrane-line' | 'partial-membrane-line' | 'no-capacity'

export interface CensusRow {
  pid: string
  protocol: 'aave-v3' | 'morpho-blue'
  chain: string
  owner: string
  /** Aave pool address or Morpho market id (lib/wavefront/pid.ts). */
  market: string
  /** Aave 'core' | 'lido' | 'etherfi' (pid.ts aaveMarketLabel); Morpho 'blue'. */
  marketLabel: string
  /** 'aave-v3:<label>' or 'morpho-blue': the venue the coverage table groups by. */
  venue: string
  events: number
  first: { block: number; ts: number }
  /** Located by the protocol's own check: the walk has an anchor (t0). */
  walked: boolean
  reason?: string
  /**
   * Walked but left out of this run's comparison, on BOTH sides: no Membrane line, or a
   * collateral token with no observed liquidity that Membrane would have to sell. `mem` is null.
   */
  excluded?: ExclusionReason
  excludedDetail?: string
  t0?: { block: number; ts: number; minute: number; shifted: boolean; priceBasis: PriceBasis }
  /**
   * What Membrane decides at t0 per half (lib/wavefront/aave.ts t0Decision) at the t0 basis,
   * and at the OTHER basis for the same event (null when that basis does not locate it).
   */
  t0Decisions?: T0Decision[]
  t0AltBasis?: {
    priceBasis: PriceBasis
    located: boolean
    ltv0: number | null
    decisions: T0Decision[] | null
  }
  unit: string
  collateral: { symbol: string; amount: number; usd: number | null; lt?: number }[]
  debt: { symbol: string; amount: number; usd: number | null }[]
  collUsd: number | null
  debtUsd: number | null
  /** The PROTOCOL's line at t0 (Aave weighted LT, Morpho LLTV): provenance, and t0's locator. */
  line: number | null
  /** Membrane's line (lineMode 'membrane'): lib/wavefront/membraneLine.ts. */
  memLine?: {
    line: number
    /** Collateral symbols with no Membrane line, left out of the weighted line. */
    unknown: string[]
    unknownShare: number
    /** Subs of a split running at the whole position's line (no leg of theirs has one). */
    lineFromWhole?: number[]
    /**
     * Membrane's t0 debt / the real t0 debt (Σ share_h x debtScale_h), and per half its line,
     * the protocol's line for the same legs, and memLine / protocolLine. Absent when unscaled.
     */
    debtScale?: number
    halves?: { sub?: number; line: number; protocolLine: number; debtScale: number }[]
  }
  ltv0: number | null
  /** The class Membrane walks it in (on the line walked). */
  delayClass: 'no-delay' | 'delayed' | 'mixed'
  /** lineMode 'membrane': the class on the protocol's line, for reference. */
  protocolDelayClass?: 'no-delay' | 'delayed' | 'mixed'
  cluster: string
  primarySymbol: string
  notes?: string[]
  real: {
    events: number
    repaidUsd: number
    /** Everything taken from the borrower; for Aave it includes the protocol fee. */
    seizedUsd: number
    /** Aave: the liquidation protocol fee part of seizedUsd. Morpho: 0. */
    protocolFeeUsd: number
    badDebtUsd: number
    unpricedEvents: number
  }
  mem: null | {
    /** The debt Membrane walks at t0, in the position's unit (sized to its line), and in USD. */
    debt0: number
    debt0Usd: number | null
    outcome: CureOutcome
    sales: number
    firstSaleMinute: number | null
    repaidUsd: number
    soldUsd: number
    unpricedSales: number
    /** Debt closed on the t0 basis, in the position's unit (== cureWalk.closedUsd). */
    closedT0: number
    breaches: number
    arms: number
    saves: number
    armedAtGridEnd: boolean
    startUnbreached: boolean
    subs?: SubRow[]
    /** Liquidity-capped runs (kernel.ts PENDING ORDERS). */
    liquidity?: {
      /** Sales whose order did not fill completely at their own minute. */
      shortSales: number
      /** Later fills of a pending remainder. */
      carryFills: number
      /** Remainders dropped because the position was back at or under its borrow cap. */
      pendingCancelled: number
      /** Repay still pending at the grid end: never sold, never credited. */
      unfilledAtGridEndUsd: number | null
    }
  }
}

export interface CensusResult {
  rows: CensusRow[]
  records: StreamRecord[]
  finalTotals: Totals
  coverage: { walked: number; total: number }
  /** The capacity table the run used (liquidity.ts computeCapacity), sorted by key. */
  capacity: CapacityEntry[]
  /** The run's liquidity settings and what the book saw (null: no liquidity model). */
  liquidity: null | {
    multiplier: number | 'research-per-class' | 'research-medians'
    /**
     * Per book key: tokens filled, offers that did not fill completely, the most filled in any
     * rolling window (never above the limit), and the limit (null: unlimited).
     */
    byKey: Record<
      string,
      {
        filledTokens: number
        shortOffers: number
        peakWindowTokens: number
        limitTokens: number | null
      }
    >
  }
  stats: {
    aaveRealPriceSources: Record<string, number>
    morphoLoanPricing: Record<string, { how: string; events: number; positions: number }>
    ownClusters: string[]
    clusterCounts: Record<string, number>
    classCounts: Record<string, number>
    splitHalves: { mixed: number; startUnbreachedHalves: number; tinyHalves: number }
    t0Shifted: string[]
    priceBasis: Record<string, number>
    zeroValueCollateralPositions: number
    locatedFloatMismatch: string[]
    /** Realised Morpho bad debt by chain and loan token, USD (walked positions). */
    morphoBadDebt: Record<string, { events: number; usd: number; units: number }>
    /**
     * Aave real events that came after the account's debt grew > 5% beyond what the previous
     * block's liquidations left (new borrowing between liquidations, or a large accrual). An
     * UPPER bound on Real repaid that Membrane's walk (t0 composition only) cannot see.
     */
    newBorrowingAfterLiquidation: { events: number; positions: number; repaidUsd: number }
  }
}

// ------------------------------------------------------------------ paths

/** Column cache: string prices → Float64Array (NaN = null), parsed once. */
class Columns {
  private cache = new Map<string, Float64Array>()
  constructor(private readonly src: Record<string, Record<string, (string | null)[]>>) {}
  /** `scope` is the file key: `${chain}:${market}` for Aave, the chain for Morpho. */
  get(scope: string, key: string): Float64Array | null {
    const k = `${scope}|${key}`
    let c = this.cache.get(k)
    if (c) return c
    const raw = this.src[scope]?.[key]
    if (!raw) return null
    c = new Float64Array(raw.length)
    for (let i = 0; i < raw.length; i++) {
      const v = raw[i]
      c[i] = v == null ? NaN : Number(v)
    }
    this.cache.set(k, c)
    return c
  }
}

const groupBy = <T>(xs: readonly T[], key: (x: T) => string) => {
  const m = new Map<string, T[]>()
  for (const x of xs) {
    const k = key(x)
    const a = m.get(k)
    if (a) a.push(x)
    else m.set(k, [x])
  }
  return m
}

const evKey = (chain: string, tx: string, log: number) => `${chain}:${tx.toLowerCase()}:${log}`

/**
 * The price a minute path holds at `minute`. A held leg with no observation there is an ERROR,
 * never carried forward (see NO SILENT GAPS above).
 */
function priceAt(col: Float64Array, minute: number, what: string): number {
  if (!(minute >= 0 && minute < col.length)) {
    throw new Error(`census: minute ${minute} outside the grid for ${what}`)
  }
  const v = col[minute]
  if (!(Number.isFinite(v) && v > 0)) {
    throw new Error(`census: no price for ${what} at minute ${minute} (${v}); gaps are an error`)
  }
  return v
}

/**
 * The Aave events of one account that came after its debt grew more than 5% beyond what the
 * previous block's liquidations left: the debt at this block's N-1 (every reserve, at this
 * block's N-1 prices) against the previous block's N-1 debt less what those liquidations
 * repaid (same prices). Events in one block share one N-1 read, so blocks are compared, not
 * events. Interest accrues too, so this is an UPPER bound on new borrowing. Returns event keys.
 */
export function newBorrowingEvents(
  evs: readonly AaveEventRecord[],
  csv: readonly AaveCsvRow[],
): string[] {
  const coverOf = new Map(
    csv.map((r) => [
      evKey(r.chain, String(r.tx_hash), Number(r.log_index)),
      Number(r.debt_to_cover_normalized),
    ]),
  )
  const blocks = [...groupBy(sortEvents(evs), (e) => String(e.block_number)).values()]
  const out: string[] = []
  const amount = (ev: AaveEventRecord, asset: string) => {
    const r = ev.position.find((x) => x.asset === asset)
    return r ? Number(BigInt(r.variableDebt) + BigInt(r.stableDebt)) / 10 ** r.decimals : 0
  }
  for (let j = 1; j < blocks.length; j++) {
    const prev = blocks[j - 1]
    const cur = blocks[j]
    const pf = prev[0]
    const cf = cur[0]
    const price = (asset: string) => {
      const r =
        cf.position.find((x) => x.asset === asset) ?? pf.position.find((x) => x.asset === asset)
      return r?.priceNm1 ? Number(r.priceNm1) / 1e8 : 0
    }
    const debtAssets = (ev: AaveEventRecord) =>
      ev.position
        .filter((x) => BigInt(x.variableDebt) + BigInt(x.stableDebt) > 0n)
        .map((x) => x.asset)
    let left = 0
    for (const a of debtAssets(pf)) {
      const repaid = prev
        .filter((e) => e.debt_asset === a)
        .reduce((acc, e) => acc + (coverOf.get(evKey(e.chain, e.tx_hash, e.log_index)) ?? 0), 0)
      left += Math.max(0, amount(pf, a) - repaid) * price(a)
    }
    const now = debtAssets(cf).reduce((acc, a) => acc + amount(cf, a) * price(a), 0)
    if (now > 1.05 * left) for (const e of cur) out.push(evKey(e.chain, e.tx_hash, e.log_index))
  }
  return out
}

// ------------------------------------------------------------------ census

export function buildCensus(inp: CensusInputs, opts: CensusOptions = {}): CensusResult {
  const W = inp.window
  const lastMinute = W.minutes - 1
  const aaveCols = new Columns(
    Object.fromEntries(Object.entries(inp.aaveOracle).map(([c, f]) => [c, f.prices])),
  )
  const morphoCols = new Columns(
    Object.fromEntries(Object.entries(inp.morphoOracle).map(([c, f]) => [c, f.prices])),
  )
  const aaveUnit = (scope: string) => {
    const f = inp.aaveOracle[scope]
    if (!f) throw new Error(`census: no AaveOracle path for ${scope}`)
    return Number(f.baseUnit)
  }
  /** USD of an Aave-listed asset at a minute; null only when the market does not list it. */
  const aaveUsdAt = (scope: string, asset: string, minute: number): number | null => {
    const col = aaveCols.get(scope, asset)
    if (!col) return null
    return priceAt(col, minute, `${scope} ${asset}`) / aaveUnit(scope)
  }
  const aaveDecimals = (scope: string, asset: string): number | null =>
    inp.aaveOracle[scope]?.assets.find((a) => a.address === asset)?.decimals ?? null

  // ---- Morpho loan-token USD: stable at $1, else the chain's core AaveOracle path, else
  // unpriced. A path value is the price in force at the minute START, not at block N.
  const loanHow = (chain: string, token: string, symbol: string): string =>
    heldAtOne(symbol)
      ? 'stable-flat-1'
      : aaveCols.get(`${chain}:${AAVE_CORE_POOL[chain]}`, token)
        ? 'aave-oracle-path'
        : 'unpriced'
  const loanUsdFn =
    (chain: string, token: string, symbol: string) =>
    (minute: number): number | null => {
      const how = loanHow(chain, token, symbol)
      if (how === 'stable-flat-1') return 1
      if (how === 'aave-oracle-path') {
        return aaveUsdAt(`${chain}:${AAVE_CORE_POOL[chain]}`, token, minute)
      }
      return null
    }

  // ---- specs ------------------------------------------------------------------------------
  interface Pos {
    spec: PositionSpec
    eventsSorted: (AaveEventRecord | MorphoEventRecord)[]
    csv: (AaveCsvRow | MorphoCsvRow)[]
    usdPerUnit: (minute: number) => number | null
    loanToken?: string
    symbols?: { collateral: string; loan: string }
  }
  const positions: Pos[] = []
  const stats: CensusResult['stats'] = {
    aaveRealPriceSources: {},
    morphoLoanPricing: {},
    ownClusters: [],
    clusterCounts: {},
    classCounts: {},
    splitHalves: { mixed: 0, startUnbreachedHalves: 0, tinyHalves: 0 },
    t0Shifted: [],
    priceBasis: {},
    zeroValueCollateralPositions: 0,
    locatedFloatMismatch: [],
    morphoBadDebt: {},
    newBorrowingAfterLiquidation: { events: 0, positions: 0, repaidUsd: 0 },
  }

  const aaveSpecOpts = {
    startTs: W.startTs,
    stepSeconds: W.stepSeconds,
    debtMinimumUsd: LIQ_DEBT_MINIMUM_USD,
    ...(opts.basisOrder ? { basisOrder: opts.basisOrder } : {}),
  }
  const aavePidOf = (r: { chain: string; pool?: string; user: string }) =>
    aavePid(r.chain, aavePoolOf(r), r.user)
  const aaveCsvByPid = groupBy(inp.aaveCsv, aavePidOf)
  const aaveEvByPid = groupBy(inp.aaveEvents, aavePidOf)
  const keep = (pid: string) => !opts.onlyPids || opts.onlyPids.has(pid)
  for (const [pid, evs] of aaveEvByPid) {
    if (!keep(pid)) continue
    const csv = aaveCsvByPid.get(pid) ?? []
    if (csv.length !== evs.length) {
      throw new Error(`census: ${pid} has ${evs.length} event records and ${csv.length} CSV rows`)
    }
    positions.push({
      spec: aavePositionSpec(evs, aaveSpecOpts),
      eventsSorted: sortEvents(evs),
      csv,
      usdPerUnit: () => 1,
    })
  }
  const morphoCsvByPos = groupBy(inp.morphoCsv, (r) => morphoPid(r.chain, r.market_id, r.borrower))
  const morphoEvByPos = groupBy(inp.morphoEvents, (e) =>
    morphoPid(e.chain, e.market_id, e.borrower),
  )
  const morphoSpecOpts = (
    sym: { collateral: string; loan: string },
    usd: (m: number) => number | null,
  ) => ({
    startTs: W.startTs,
    stepSeconds: W.stepSeconds,
    debtMinimumUsd: LIQ_DEBT_MINIMUM_USD,
    collateralSymbol: sym.collateral,
    loanSymbol: sym.loan,
    loanUsd: usd,
    ...(opts.basisOrder ? { basisOrder: opts.basisOrder } : {}),
  })
  for (const [k, evs] of morphoEvByPos) {
    if (!keep(k)) continue
    const csv = morphoCsvByPos.get(k) ?? []
    if (csv.length !== evs.length) {
      throw new Error(`census: ${k} has ${evs.length} event records and ${csv.length} CSV rows`)
    }
    const sym = { collateral: csv[0].collateral_symbol, loan: csv[0].loan_symbol }
    const loanToken = evs[0].loanToken.toLowerCase()
    const usd = loanUsdFn(evs[0].chain, loanToken, sym.loan)
    const spec = morphoPositionSpec(evs, morphoSpecOpts(sym, usd))
    const how = loanHow(evs[0].chain, loanToken, sym.loan)
    const lk = `${evs[0].chain}:${sym.loan}`
    const s = (stats.morphoLoanPricing[lk] ??= { how, events: 0, positions: 0 })
    s.positions++
    s.events += csv.length
    positions.push({
      spec,
      eventsSorted: sortEvents(evs),
      csv,
      usdPerUnit: usd,
      loanToken,
      symbols: sym,
    })
  }

  // ---- clusters ---------------------------------------------------------------------------
  const prim = positions.map((p) => primarySymbol(p.spec.collateral))
  const { clusterOf, ownClusters } = clusterAssigner(prim)
  stats.ownClusters = ownClusters

  // ---- liquidity: the capacity table and the shared book -----------------------------------
  const capacity = opts.capacity ?? capacityTable(inp, aaveUsdAt, aaveDecimals, loanUsdFn, W)
  const capMap = new Map(capacity.map((c) => [c.key, c.capacityTokens]))
  const multiplier = opts.capacityMultiplier ?? CAPACITY_MULTIPLIER
  const symbolOf = new Map(capacity.map((c) => [c.key, c.symbol]))
  const bookMultiplier =
    multiplier === 'research-per-class'
      ? (key: string) => researchClassMultiplier(symbolOf.get(key) ?? '')
      : multiplier === 'research-medians'
        ? (key: string) => researchMedianMultiplier(symbolOf.get(key) ?? '')
        : multiplier
  const book = opts.noCapacityModel ? null : new LiquidityBook(capMap, bookMultiplier, W.minutes)
  const lineMode = opts.lineMode ?? 'membrane'

  // ---- per position: open, real; the walk plan ----------------------------------------------
  interface Emitted {
    rec: StreamRecord
    pos: number
    local: number
  }
  const emitted: Emitted[] = []
  const evIndexAave = new Map(
    inp.aaveEvents.map((e) => [evKey(e.chain, e.tx_hash, e.log_index), e]),
  )
  const evIndexMorpho = new Map(
    inp.morphoEvents.map((e) => [evKey(e.chain, e.tx_hash, e.log_index), e]),
  )
  const feeIndex = new Map(inp.aaveFees.map((f) => [evKey(f.chain, f.tx_hash, f.log_index), f]))

  /** The halves Membrane walks for a spec: its own line (headline) or the protocol's. */
  const planOf = (sp: PositionSpec): { halves: HalfSpec[]; plan: MembraneLinePlan | null } => {
    if (lineMode === 'protocol') return { halves: sp.halves, plan: null }
    const plan = membraneLinePlan(sp.collateral)
    if (!plan) return { halves: [], plan }
    return { halves: opts.noDebtScaling ? plan.halves : scaledHalves(plan, sp), plan }
  }

  interface Walk {
    pi: number
    spec: PositionSpec
    halves: HalfSpec[]
    kernels: MembraneKernel[]
    memRecs: MemRecord[]
    ratioAt: (leg: KernelLeg, minute: number) => number
  }
  interface Prepared {
    s: PositionSpec
    walked: boolean
    cluster: string
    open: OpenRecord
    realRecs: RealRecord[]
    feeByRec: Map<number, number>
    halves: HalfSpec[]
    plan: MembraneLinePlan | null
    excluded?: { reason: ExclusionReason; detail: string }
    walk?: Walk
  }
  const prepared: Prepared[] = []

  const kernelsFor = (
    s: PositionSpec,
    halves: readonly HalfSpec[],
    usdPerUnit: (m: number) => number | null,
    liquidity: KernelLiquidity | undefined,
  ) =>
    halves.map((h) => {
      const legs = kernelLegs(s, h)
      return new MembraneKernel({
        pid: s.pid,
        ...(h.sub !== undefined ? { sub: h.sub } : {}),
        collateral: legs.collateral,
        debt: legs.debt,
        line: h.line,
        noDelay: h.delayClass === 'no-delay',
        band: opts.band ?? MAX_THRESHOLD_TO_DELAY,
        delaySteps: DELAY_STEPS,
        gap: BORROW_LTV_GAP,
        debtMinimum: opts.noDebtFloor ? 0 : s.debtMinimum,
        maxSales: opts.maxSales ?? MAX_SALES,
        ...(opts.noEarlyClear ? { noEarlyClear: true } : {}),
        t0Minute: s.t0!.minute,
        t0Ts: s.t0!.ts,
        startTs: W.startTs,
        stepSeconds: W.stepSeconds,
        lastMinute,
        usdPerUnit,
        stopAfterT0BandSale: opts.stopAfterT0BandSale,
        ...(liquidity ? { liquidity } : {}),
      })
    })

  /** Walk kernels alone (no shared book): the pre-pass for a no-capacity holding. */
  const soloSells = (w: Walk): boolean => {
    for (const k of w.kernels) w.memRecs.push(...k.start())
    for (let m = w.spec.t0!.minute + 1; m <= lastMinute; m++) {
      let live = false
      for (const k of w.kernels) {
        if (k.isDone) continue
        live = true
        w.memRecs.push(...k.step(m, (leg) => w.ratioAt(leg, m)))
      }
      if (!live) break
    }
    for (const k of w.kernels) w.memRecs.push(...k.finish())
    return w.kernels.some((k) => k.result().sales > 0)
  }

  positions.forEach((P, pi) => {
    const s =
      opts.specOverride && P.spec.located && P.spec.t0
        ? opts.specOverride(P.spec, P.eventsSorted)
        : P.spec
    const cluster = clusterOf(prim[pi])
    stats.clusterCounts[cluster] = (stats.clusterCounts[cluster] ?? 0) + 1
    if (s.notes.some((n) => n.startsWith('collateral worth 0')))
      stats.zeroValueCollateralPositions++
    if (s.t0?.shifted) stats.t0Shifted.push(s.pid)
    const walked = s.located && !!s.t0 && s.halves.length > 0
    if (walked && s.t0)
      stats.priceBasis[s.t0.priceBasis] = (stats.priceBasis[s.t0.priceBasis] ?? 0) + 1
    const aaveScope = `${s.chain}:${s.market}`

    // ---- the line Membrane walks at, and whether the headline compares this position
    const { halves, plan } = walked ? planOf(s) : { halves: [] as HalfSpec[], plan: null }
    let excluded: Prepared['excluded']
    if (walked && lineMode === 'membrane') {
      if (!plan) {
        excluded = {
          reason: 'no-membrane-line',
          detail: `no Membrane line for ${[...new Set(s.collateral.map((l) => l.symbol))].join(', ')}: none of its collateral has a modelled or deploy-listed Membrane max LTV (lib/position-sim/membrane.ts MEMBRANE_ASSET_LTV)`,
        }
      } else if (!opts.allowPartialLines && plan.unknown.length) {
        excluded = {
          reason: 'partial-membrane-line',
          detail: `no Membrane line for ${plan.unknown.join(', ')}: a position holding ANY collateral without a Membrane line is left out (owner ruling 2026-10-18)`,
        }
      }
    }
    const walkedClass: DelayClass =
      walked && !excluded
        ? lineMode === 'protocol'
          ? s.delayClass
          : (plan as MembraneLinePlan).delayClass
        : s.delayClass
    stats.classCounts[walkedClass] = (stats.classCounts[walkedClass] ?? 0) + 1
    const walkLine = walked && !excluded && plan ? plan.line : s.line

    const open: OpenRecord = {
      kind: 'open',
      seq: 0,
      pid: s.pid,
      protocol: s.protocol,
      chain: s.chain,
      block: s.first.block,
      ts: s.first.ts,
      legs: streamLegs(s.collateral),
      debtLegs: streamLegs(s.debt),
      debtUsd: s.debtUsd,
      collUsd: s.collUsd,
      line: walkLine,
      ltv0: s.ltv0,
      delayClass: walkedClass,
      cluster,
      walked,
    }
    if (!walked) open.reason = s.reason ?? 'not walked'
    if (walked && s.t0) {
      open.t0 = { block: s.t0.block, ts: s.t0.ts, minute: s.t0.minute }
      open.priceBasis = s.t0.priceBasis
    }
    if (walked && !excluded && halves.some((h) => h.debtScale !== undefined)) {
      // additive (schema 2): the t0 debt Membrane walks, sized to its line
      open.memDebtUsd = s.debtUsd == null ? null : s.debtUsd * debtScaleOf(halves)
    }
    if (walked && !excluded && halves.length > 1) {
      open.subs = halves.map((h) => ({
        sub: h.sub as number,
        delayClass: h.delayClass,
        line: h.line,
        share: h.share,
        collUsd: s.collUsd == null ? null : s.collUsd * h.share,
        debtUsd: s.debtUsd == null ? null : s.debtUsd * h.share,
      }))
    }

    // ---- real
    const realRecs: RealRecord[] = []
    const feeByRec = new Map<number, number>()
    const csvSorted = [...P.csv].sort(
      (a, b) =>
        Number(a.block_number) - Number(b.block_number) ||
        Number(a.log_index) - Number(b.log_index),
    )
    for (const row of csvSorted) {
      const block = Number(row.block_number)
      const ts = Number(row.ts)
      const log = Number(row.log_index)
      const key = evKey(s.chain, String(row.tx_hash), log)
      const minute = minuteOf(ts, W.startTs, W.stepSeconds)
      let rec: RealRecord
      if (s.protocol === 'aave-v3') {
        const ev = evIndexAave.get(key)
        const fee = feeIndex.get(key)
        if (!fee) throw new Error(`census: no protocol-fee record for ${key}`)
        const casset = (row as AaveCsvRow).collateral_asset
        const dec =
          ev?.position.find((x) => x.asset === casset)?.decimals ?? aaveDecimals(aaveScope, casset)
        if (dec == null) throw new Error(`census: no decimals for ${casset} (${key})`)
        const r = aaveRealUsd(row as AaveCsvRow, ev, fee, dec, (asset) =>
          aaveUsdAt(aaveScope, asset, minute),
        )
        for (const src of [r.debtPriceSource, r.collPriceSource] as PriceSource[]) {
          stats.aaveRealPriceSources[src] = (stats.aaveRealPriceSources[src] ?? 0) + 1
        }
        if (r.protocolFeeUsd != null) feeByRec.set(realRecs.length, r.protocolFeeUsd)
        rec = {
          kind: 'real',
          seq: 0,
          pid: s.pid,
          ts,
          block,
          tx: String(row.tx_hash).toLowerCase(),
          logIndex: log,
          repaidUsd: r.repaidUsd,
          seizedUsd: r.seizedUsd,
        }
      } else {
        const ev = evIndexMorpho.get(key)
        const r = morphoRealUsd(row as MorphoCsvRow, ev, P.usdPerUnit(minute))
        const bad = Number((row as MorphoCsvRow).bad_debt_assets_normalized || 0)
        if (walked && bad > 0) {
          const bk = `${s.chain}:${P.symbols!.loan}`
          const b = (stats.morphoBadDebt[bk] ??= { events: 0, usd: 0, units: 0 })
          b.events++
          b.units += bad
          b.usd += r.badDebtUsd ?? 0
        }
        rec = {
          kind: 'real',
          seq: 0,
          pid: s.pid,
          ts,
          block,
          tx: String(row.tx_hash).toLowerCase(),
          logIndex: log,
          repaidUsd: r.repaidUsd,
          seizedUsd: r.seizedUsd,
          badDebtUsd: r.badDebtUsd,
        }
      }
      realRecs.push(rec)
    }

    const prep: Prepared = { s, walked, cluster, open, realRecs, feeByRec, halves, plan, excluded }
    prepared.push(prep)
    if (walked && s.ltv0 != null && s.line != null && !(s.ltv0 > s.line))
      stats.locatedFloatMismatch.push(s.pid)
    if (!walked || excluded || !s.t0) return
    const anchors = pathAnchors(s)
    const cols = new Map<string, Float64Array>()
    for (const k of anchors.keys()) {
      const col = s.protocol === 'aave-v3' ? aaveCols.get(aaveScope, k) : morphoCols.get(s.chain, k)
      if (!col) throw new Error(`census: ${s.pid} holds ${k}, which has no minute path`)
      cols.set(k, col)
    }
    const override = opts.ratioOverride
    // Every held leg must have a price at every minute walked: a gap throws (priceAt), it is
    // never carried forward. The kernel would throw too (its default `missingPrice`).
    const ratioAt = (leg: KernelLeg, m: number): number => {
      if (override) {
        const o = override(s, leg, m)
        if (o !== undefined) return o as number
      }
      if (!leg.key) return 1
      const p0 = anchors.get(leg.key) as number
      if (!(p0 > 0)) throw new Error(`census: ${s.pid} has no t0 price for ${leg.key}`)
      return priceAt(cols.get(leg.key)!, m, `${s.pid} ${leg.symbol}`) / p0
    }

    // ---- NO CAPACITY: a collateral token nobody liquidated on this chain has no capacity.
    // A position holding one is walked alone first; if Membrane would ever sell it, it is left
    // out of the headline (it never touches the book). Before a first sale the capped and the
    // uncapped walks are identical, so the solo walk decides exactly that.
    if (book) {
      const dry = [
        ...new Set(
          halves.flatMap((h) =>
            h.collateral
              .filter((l) => !l.token || !book.hasCapacity(liqKeyOf(s.chain, l.token)))
              .map((l) => l.symbol),
          ),
        ),
      ]
      if (dry.length) {
        const solo: Walk = {
          pi,
          spec: s,
          halves,
          kernels: kernelsFor(s, halves, P.usdPerUnit, undefined),
          memRecs: [],
          ratioAt,
        }
        if (soloSells(solo)) {
          prep.excluded = {
            reason: 'no-capacity',
            detail: `Membrane would sell ${dry.join(', ')} on ${s.chain}, where no liquidation of the window took any: no observed capacity`,
          }
          return
        }
      }
    }
    // Every offer of this position goes to the shared book; a no-capacity token is never offered.
    const liquidity: KernelLiquidity | undefined = book
      ? {
          take: (m, legs) => {
            for (const l of legs) {
              if (l.tokens > 0 && !book.hasCapacity(l.liqKey)) {
                throw new Error(`census: ${s.pid} offered ${l.liqKey}, which has no capacity`)
              }
            }
            return book.take(m, legs)
          },
        }
      : undefined
    prep.walk = {
      pi,
      spec: s,
      halves,
      kernels: kernelsFor(s, halves, P.usdPerUnit, liquidity),
      memRecs: [],
      ratioAt,
    }
  })

  // ---- THE WALK: every position, minute by minute, in one deterministic order -------------
  // Minute, then pid (then the half's sub): the order the shared liquidity book is drawn in.
  // Uncapped, positions are independent and this is the per-position walk, record for record.
  const walks = prepared
    .filter((p) => p.walk)
    .map((p) => p.walk as Walk)
    .sort((a, b) => (a.spec.pid < b.spec.pid ? -1 : a.spec.pid > b.spec.pid ? 1 : 0))
  let active = walks
  const firstMinute = walks.reduce((a, w) => Math.min(a, w.spec.t0!.minute), Infinity)
  for (let m = firstMinute; m <= lastMinute && active.length; m++) {
    const next: Walk[] = []
    for (const w of active) {
      const t0m = w.spec.t0!.minute
      if (m < t0m) {
        next.push(w)
        continue
      }
      if (m === t0m) {
        for (const k of w.kernels) w.memRecs.push(...k.start())
      } else {
        for (const k of w.kernels) {
          if (k.isDone) continue
          w.memRecs.push(...k.step(m, (leg) => w.ratioAt(leg, m)))
        }
      }
      if (w.kernels.some((k) => !k.isDone)) next.push(w)
    }
    active = next
  }
  for (const w of walks) for (const k of w.kernels) w.memRecs.push(...k.finish())

  // ---- rows, in position order ---------------------------------------------------------------
  const rows: CensusRow[] = []
  prepared.forEach((prep, pi) => {
    const P = positions[pi]
    const { s, walked, cluster, open, realRecs, feeByRec, halves, plan, excluded } = prep
    let local = 0
    const emit = (rec: StreamRecord) =>
      emitted.push({ rec: roundRecord(rec), pos: pi, local: local++ })
    if (excluded) {
      open.walked = false
      open.reason = excluded.detail
    }
    emit(open)

    let memRow: CensusRow['mem'] = null
    const memRecs: MemRecord[] = prep.walk ? prep.walk.memRecs : []
    if (prep.walk) {
      const w = prep.walk
      const results: KernelResult[] = w.kernels.map((k) => k.result())
      if (opts.probe) {
        opts.probe({
          spec: s,
          halves,
          line: (plan ? plan.line : s.line) as number,
          debtScale: debtScaleOf(halves),
          delayClass: open.delayClass,
          results,
          ratioAt: w.ratioAt,
          usdPerUnit: P.usdPerUnit,
          lastMinute,
        })
      }
      // Per-half rows and the whole position's figures.
      const rounded = memRecs.map((r) => roundRecord(r))
      const sumOf = (sub: number | undefined, f: (r: MemRecord) => number | null) =>
        rounded
          .filter((r) => (r.event === 'sell' || r.event === 'sell-instant') && r.sub === sub)
          .reduce((a, r) => a + (f(r) ?? 0), 0)
      const subs: SubRow[] | undefined =
        halves.length > 1
          ? halves.map((h, k) => ({
              sub: h.sub as number,
              delayClass: h.delayClass,
              line: h.line,
              share: h.share,
              symbols: h.collateral.map((l) => l.symbol),
              outcome: results[k].outcome,
              sales: results[k].sales,
              closedT0: results[k].closedT0,
              repaidUsd: results[k].repaidUsd == null ? null : sumOf(h.sub, (r) => r.repaidUsd),
              startUnbreached: results[k].startUnbreached,
              armedAtGridEnd: results[k].armedAtGridEnd,
            }))
          : undefined
      if (subs) {
        stats.splitHalves.mixed++
        stats.splitHalves.startUnbreachedHalves += subs.filter((x) => x.startUnbreached).length
        stats.splitHalves.tinyHalves += subs.filter((x) => x.share < 0.01).length
      }
      const sells = rounded.filter((r) => r.event === 'sell' || r.event === 'sell-instant')
      // The position's outcome: an unsplit position's own; a split one's DOMINANT half (the
      // larger share of the debt; ties: sub 0). Each half's outcome is in subs[].
      let dom = 0
      halves.forEach((h, k) => {
        if (h.share > halves[dom].share) dom = k
      })
      const outcome: CureOutcome = results[dom].outcome
      const unfilledUsd = results.reduce<number | null>(
        (a, r) => (a == null || r.unfilledAtGridEndUsd == null ? null : a + r.unfilledAtGridEndUsd),
        0,
      )
      // The debt Membrane walks at t0 (the halves' scaled debt; == the real debt unscaled).
      const memDebt0 = s.debt.reduce((a, l) => a + l.value0, 0) * debtScaleOf(halves)
      memRow = {
        debt0: memDebt0,
        debt0Usd: s.debtUsd == null ? null : s.debtUsd * debtScaleOf(halves),
        outcome,
        sales: results.reduce((a, r) => a + r.sales, 0),
        firstSaleMinute: sells.length ? Math.min(...sells.map((r) => r.minute)) : null,
        repaidUsd: sells.reduce((a, r) => a + (r.repaidUsd ?? 0), 0),
        soldUsd: sells.reduce((a, r) => a + (r.soldUsd ?? 0), 0),
        unpricedSales: sells.filter((r) => r.repaidUsd == null || r.soldUsd == null).length,
        closedT0: results.reduce((a, r) => a + r.closedT0, 0),
        breaches: results.reduce((a, r) => a + r.breaches, 0),
        arms: rounded.filter((r) => r.event === 'arm').length,
        saves: rounded.filter((r) => r.event === 'save').length,
        armedAtGridEnd: results.some((r) => r.armedAtGridEnd),
        startUnbreached: results.every((r) => r.startUnbreached),
        ...(subs ? { subs } : {}),
        ...(book
          ? {
              liquidity: {
                shortSales: results.reduce((a, r) => a + r.shortSales, 0),
                carryFills: results.reduce((a, r) => a + r.carryFills, 0),
                pendingCancelled: results.reduce((a, r) => a + r.pendingCancelled, 0),
                unfilledAtGridEndUsd:
                  unfilledUsd == null ? null : Math.round(unfilledUsd * 100) / 100,
              },
            }
          : {}),
      }
    }
    for (const r of realRecs) emit(r)
    for (const r of memRecs) emit(r)

    // ---- t0 decisions (on the halves walked) at this basis and at the other one
    let t0Decisions: T0Decision[] | undefined
    let t0AltBasis: CensusRow['t0AltBasis']
    if (walked && s.t0 && s.ltv0 != null && !excluded) {
      // on the debt Membrane walks: LTV0 x the half's debt scale (1 unscaled)
      t0Decisions = halves.map((h) =>
        t0Decision(s.ltv0! * (h.debtScale ?? 1), h, MAX_THRESHOLD_TO_DELAY),
      )
      const alt: PriceBasis = s.t0.priceBasis === 'N' ? 'N-1' : 'N'
      const altSpec =
        s.protocol === 'aave-v3'
          ? aaveSpecAt(P.eventsSorted as AaveEventRecord[], s.t0.eventIndex, alt, aaveSpecOpts)
          : morphoSpecAt(
              P.eventsSorted as MorphoEventRecord[],
              s.t0.eventIndex,
              alt,
              morphoSpecOpts(P.symbols!, P.usdPerUnit),
            )
      const altHalves =
        altSpec.located && altSpec.ltv0 != null && altSpec.halves.length
          ? planOf(altSpec).halves
          : []
      t0AltBasis = {
        priceBasis: alt,
        located: altSpec.located,
        ltv0: altSpec.ltv0,
        decisions: altHalves.length
          ? altHalves.map((h) =>
              t0Decision(altSpec.ltv0! * (h.debtScale ?? 1), h, MAX_THRESHOLD_TO_DELAY),
            )
          : null,
      }
    }

    const realRounded = realRecs.map((r) => roundRecord(r))
    rows.push({
      pid: s.pid,
      protocol: s.protocol,
      chain: s.chain,
      owner: s.owner,
      market: s.market,
      marketLabel: s.marketLabel,
      venue: s.protocol === 'aave-v3' ? `aave-v3:${s.marketLabel}` : 'morpho-blue',
      events: P.csv.length,
      first: s.first,
      walked,
      ...(walked ? {} : { reason: open.reason }),
      ...(excluded ? { excluded: excluded.reason, excludedDetail: excluded.detail } : {}),
      ...(walked && s.t0
        ? {
            t0: {
              block: s.t0.block,
              ts: s.t0.ts,
              minute: s.t0.minute,
              shifted: s.t0.shifted,
              priceBasis: s.t0.priceBasis,
            },
            ...(t0Decisions ? { t0Decisions, t0AltBasis } : {}),
          }
        : {}),
      unit: s.unit,
      collateral: s.collateral.map((l) => ({
        symbol: l.symbol,
        amount: l.amount,
        usd: l.usd,
        ...(l.lt !== undefined ? { lt: l.lt } : {}),
      })),
      debt: s.debt.map((l) => ({ symbol: l.symbol, amount: l.amount, usd: l.usd })),
      collUsd: s.collUsd,
      debtUsd: s.debtUsd,
      line: s.line,
      ...(plan
        ? {
            memLine: {
              line: plan.line,
              unknown: plan.unknown,
              unknownShare: plan.unknownShare,
              ...(plan.lineFromWhole.length ? { lineFromWhole: plan.lineFromWhole } : {}),
              ...(walked && !excluded && !opts.noDebtScaling
                ? {
                    debtScale: debtScaleOf(halves),
                    halves: halves.map((h) => ({
                      ...(h.sub !== undefined ? { sub: h.sub } : {}),
                      line: h.line,
                      protocolLine: membraneDebtScale(h, s, halves.length > 1).protocolLine,
                      debtScale: h.debtScale ?? 1,
                    })),
                  }
                : {}),
            },
          }
        : {}),
      ltv0: s.ltv0,
      delayClass: open.delayClass,
      ...(lineMode === 'membrane' ? { protocolDelayClass: s.delayClass } : {}),
      cluster,
      primarySymbol: prim[pi],
      ...(s.notes.length ? { notes: s.notes } : {}),
      real: {
        events: realRounded.length,
        repaidUsd: realRounded.reduce((a, r) => a + (r.repaidUsd ?? 0), 0),
        seizedUsd: realRounded.reduce((a, r) => a + (r.seizedUsd ?? 0), 0),
        protocolFeeUsd: [...feeByRec.values()].reduce((a, v) => a + v, 0),
        badDebtUsd: realRounded.reduce((a, r) => a + (r.badDebtUsd ?? 0), 0),
        unpricedEvents: realRounded.filter((r) => r.repaidUsd == null || r.seizedUsd == null)
          .length,
      },
      mem: memRow,
    })

    // ---- Real events after new borrowing (Aave; a limit the docs state, see stats)
    if (walked && s.protocol === 'aave-v3') {
      const nb = newBorrowingEvents(P.eventsSorted as AaveEventRecord[], P.csv as AaveCsvRow[])
      if (nb.length) {
        stats.newBorrowingAfterLiquidation.positions++
        stats.newBorrowingAfterLiquidation.events += nb.length
        const byKey = new Map(realRounded.map((r) => [evKey(s.chain, r.tx, r.logIndex), r]))
        for (const k of nb)
          stats.newBorrowingAfterLiquidation.repaidUsd += byKey.get(k)?.repaidUsd ?? 0
      }
    }
  })

  // ---- one stream, in time order, ticks folded by the reducer ----------------------------
  emitted.sort(
    (a, b) =>
      a.rec.ts - b.rec.ts ||
      KIND_RANK[a.rec.kind] - KIND_RANK[b.rec.kind] ||
      a.pos - b.pos ||
      a.local - b.local,
  )
  const state = createReplayState()
  const records: StreamRecord[] = []
  let seq = 0
  let nextTick = 0
  while (nextTick <= lastMinute && !isTickMinute(nextTick)) nextTick++
  const tickTsOf = (m: number) => W.startTs + W.stepSeconds * (m + 1)
  const flushTicksBefore = (ts: number) => {
    while (nextTick <= lastMinute && tickTsOf(nextTick) <= ts) {
      const t = tickFromState(state, W, nextTick)
      t.seq = ++seq
      applyRecord(state, t)
      records.push(t)
      nextTick += TICK_EVERY_MINUTES
    }
  }
  for (const e of emitted) {
    flushTicksBefore(e.rec.ts)
    e.rec.seq = ++seq
    applyRecord(state, e.rec)
    records.push(e.rec)
  }
  flushTicksBefore(Infinity)

  const byKey: Record<
    string,
    {
      filledTokens: number
      shortOffers: number
      peakWindowTokens: number
      limitTokens: number | null
    }
  > = {}
  if (book) {
    for (const k of [...new Set([...book.filled.keys(), ...book.shortOffers.keys()])].sort()) {
      const lim = book.limitOf(k)
      byKey[k] = {
        filledTokens: book.filled.get(k) ?? 0,
        shortOffers: book.shortOffers.get(k) ?? 0,
        peakWindowTokens: book.peakWindow(k),
        limitTokens: lim === Infinity ? null : lim,
      }
    }
  }
  return {
    rows,
    records,
    finalTotals: state.totals,
    coverage: { ...state.coverage },
    stats,
    capacity,
    liquidity: book ? { multiplier, byKey } : null,
  }
}

/**
 * The capacity table from every liquidation of the inputs (lib/wavefront/liquidity.ts): each
 * event's collateral that left the borrower — Aave liquidatedCollateralAmount + the protocol
 * fee (aave-protocol-fee collateralSeizedTotalRaw), Morpho seized assets — in raw tokens, on the
 * event's grid minute; its USD is the real side's own seized figure (aaveRealUsd /
 * morphoRealUsd), so the table and the real side price the same events the same way.
 */
/** The position's debt factor: each half's share of the debt x its debt scale, summed. */
function debtScaleOf(halves: readonly HalfSpec[]): number {
  return halves.reduce((a, h) => a + h.share * (h.debtScale ?? 1), 0)
}

function capacityTable(
  inp: CensusInputs,
  aaveUsdAt: (scope: string, asset: string, minute: number) => number | null,
  aaveDecimals: (scope: string, asset: string) => number | null,
  loanUsdFn: (chain: string, token: string, symbol: string) => (m: number) => number | null,
  W: StreamWindow,
): CapacityEntry[] {
  const evA = new Map(inp.aaveEvents.map((e) => [evKey(e.chain, e.tx_hash, e.log_index), e]))
  const evM = new Map(inp.morphoEvents.map((e) => [evKey(e.chain, e.tx_hash, e.log_index), e]))
  const fees = new Map(inp.aaveFees.map((f) => [evKey(f.chain, f.tx_hash, f.log_index), f]))
  const out: CapacityEvent[] = []
  for (const row of inp.aaveCsv) {
    const key = evKey(row.chain, String(row.tx_hash), Number(row.log_index))
    const fee = fees.get(key)
    if (!fee) throw new Error(`capacity: no protocol-fee record for ${key}`)
    const ev = evA.get(key)
    const scope = `${row.chain}:${aavePoolOf(row)}`
    const asset = row.collateral_asset.toLowerCase()
    const reserve = ev?.position.find((x) => x.asset === asset)
    const meta = inp.aaveOracle[scope]?.assets.find((a) => a.address === asset)
    const decimals = reserve?.decimals ?? aaveDecimals(scope, asset)
    const symbol = reserve?.symbol ?? meta?.symbol
    if (decimals == null || !symbol) throw new Error(`capacity: no decimals/symbol for ${asset}`)
    const minute = minuteOf(Number(row.ts), W.startTs, W.stepSeconds)
    const total = BigInt(fee.collateralSeizedTotalRaw)
    const usd = aaveRealUsd(row, ev, fee, decimals, (a) => aaveUsdAt(scope, a, minute)).seizedUsd
    out.push({
      chain: row.chain,
      token: asset,
      symbol,
      decimals,
      minute,
      liquidatorRaw: total - BigInt(fee.protocolFeeRaw),
      borrowerRaw: total,
      usd,
    })
  }
  for (const row of inp.morphoCsv) {
    const key = evKey(row.chain, String(row.tx_hash), Number(row.log_index))
    const ev = evM.get(key)
    if (!ev) throw new Error(`capacity: no Morpho event record for ${key}`)
    const minute = minuteOf(Number(row.ts), W.startTs, W.stepSeconds)
    const raw = BigInt(row.seized_assets)
    const loan = loanUsdFn(ev.chain, ev.loanToken.toLowerCase(), row.loan_symbol)(minute)
    out.push({
      chain: row.chain,
      token: ev.collateralToken.toLowerCase(),
      symbol: row.collateral_symbol,
      decimals: ev.collateralDecimals,
      minute,
      liquidatorRaw: raw,
      borrowerRaw: raw,
      usd: morphoRealUsd(row, ev, loan).seizedUsd,
    })
  }
  return computeCapacity(out, W.minutes)
}

/**
 * THE SHARE OF DEBT CLOSED over a set of rows (owner ruling 2026-10-18, second round), the one
 * definition both builders use: over the PRICED compared rows,
 *   realShare = Σ real repaid / Σ real t0 debt (USD)
 *   memShare  = Σ (closedT0 / mem.debt0) x mem.debt0Usd / Σ mem.debt0Usd   (Membrane's own t0
 *               debt, sized to its line; closed on the t0 basis)
 *   gapPp     = (realShare − memShare) x 100; positive = Membrane closes a smaller share.
 * Shares are rounded to 1e-5 and the gap to 1e-4 pp.
 */
export function censusShares(rows: readonly CensusRow[]) {
  const p = rows.filter(
    (r) =>
      r.debtUsd != null &&
      r.collUsd != null &&
      r.real.unpricedEvents === 0 &&
      !!r.mem &&
      r.mem.unpricedSales === 0 &&
      r.mem.debt0Usd != null &&
      r.mem.debt0 > 0 &&
      r.debtUsd > 0,
  )
  const rd = p.reduce((a, r) => a + r.debtUsd!, 0)
  const md = p.reduce((a, r) => a + r.mem!.debt0Usd!, 0)
  const realShare = rd > 0 ? p.reduce((a, r) => a + r.real.repaidUsd, 0) / rd : 0
  const memShare =
    md > 0 ? p.reduce((a, r) => a + (r.mem!.closedT0 / r.mem!.debt0) * r.mem!.debt0Usd!, 0) / md : 0
  const r5 = (x: number) => Math.round(x * 1e5) / 1e5
  return {
    pricedPositions: p.length,
    realDebtUsd: Math.round(rd * 100) / 100,
    memDebtUsd: Math.round(md * 100) / 100,
    realShare: r5(realShare),
    memShare: r5(memShare),
    gapPp: Math.round((r5(realShare) - r5(memShare)) * 100 * 1e4) / 1e4,
  }
}
