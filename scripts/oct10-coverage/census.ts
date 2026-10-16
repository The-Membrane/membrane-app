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
  type PositionSpec,
  type PriceBasis,
  type PriceSource,
  type T0Decision,
} from '../../lib/wavefront/aave'
import { clusterAssigner, primarySymbol } from '../../lib/wavefront/cluster'
import { MembraneKernel, type KernelLeg, type KernelResult } from '../../lib/wavefront/kernel'
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
  walked: boolean
  reason?: string
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
  line: number | null
  ltv0: number | null
  delayClass: 'no-delay' | 'delayed' | 'mixed'
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
  }
}

export interface CensusResult {
  rows: CensusRow[]
  records: StreamRecord[]
  finalTotals: Totals
  coverage: { walked: number; total: number }
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

  // ---- per position: open, real, mem --------------------------------------------------------
  interface Emitted {
    rec: StreamRecord
    pos: number
    local: number
  }
  const emitted: Emitted[] = []
  const rows: CensusRow[] = []
  const evIndexAave = new Map(
    inp.aaveEvents.map((e) => [evKey(e.chain, e.tx_hash, e.log_index), e]),
  )
  const evIndexMorpho = new Map(
    inp.morphoEvents.map((e) => [evKey(e.chain, e.tx_hash, e.log_index), e]),
  )
  const feeIndex = new Map(inp.aaveFees.map((f) => [evKey(f.chain, f.tx_hash, f.log_index), f]))

  positions.forEach((P, pi) => {
    const s =
      opts.specOverride && P.spec.located && P.spec.t0
        ? opts.specOverride(P.spec, P.eventsSorted)
        : P.spec
    let local = 0
    const emit = (rec: StreamRecord) =>
      emitted.push({ rec: roundRecord(rec), pos: pi, local: local++ })
    const cluster = clusterOf(prim[pi])
    stats.clusterCounts[cluster] = (stats.clusterCounts[cluster] ?? 0) + 1
    stats.classCounts[s.delayClass] = (stats.classCounts[s.delayClass] ?? 0) + 1
    if (s.notes.some((n) => n.startsWith('collateral worth 0')))
      stats.zeroValueCollateralPositions++
    if (s.t0?.shifted) stats.t0Shifted.push(s.pid)
    const walked = s.located && !!s.t0 && s.halves.length > 0
    if (walked && s.t0)
      stats.priceBasis[s.t0.priceBasis] = (stats.priceBasis[s.t0.priceBasis] ?? 0) + 1
    const aaveScope = `${s.chain}:${s.market}`

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
      line: s.line,
      ltv0: s.ltv0,
      delayClass: s.delayClass,
      cluster,
      walked,
    }
    if (!walked) open.reason = s.reason ?? 'not walked'
    if (walked && s.t0) {
      open.t0 = { block: s.t0.block, ts: s.t0.ts, minute: s.t0.minute }
      open.priceBasis = s.t0.priceBasis
    }
    if (walked && s.halves.length > 1) {
      open.subs = s.halves.map((h) => ({
        sub: h.sub as number,
        delayClass: h.delayClass,
        line: h.line,
        share: h.share,
        collUsd: s.collUsd == null ? null : s.collUsd * h.share,
        debtUsd: s.debtUsd == null ? null : s.debtUsd * h.share,
      }))
    }
    emit(open)

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

    // ---- mem
    let memRow: CensusRow['mem'] = null
    const memRecs: MemRecord[] = []
    if (walked && s.t0) {
      if (s.ltv0 != null && s.line != null && !(s.ltv0 > s.line))
        stats.locatedFloatMismatch.push(s.pid)
      const anchors = pathAnchors(s)
      const cols = new Map<string, Float64Array>()
      for (const k of anchors.keys()) {
        const col =
          s.protocol === 'aave-v3' ? aaveCols.get(aaveScope, k) : morphoCols.get(s.chain, k)
        if (!col) throw new Error(`census: ${s.pid} holds ${k}, which has no minute path`)
        cols.set(k, col)
      }
      const kernels = s.halves.map((h) => {
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
          usdPerUnit: P.usdPerUnit,
          stopAfterT0BandSale: opts.stopAfterT0BandSale,
        })
      })
      for (const k of kernels) memRecs.push(...k.start())
      let m = 0
      const override = opts.ratioOverride
      // Every held leg must have a price at every minute walked: a gap throws (priceAt), it is
      // never carried forward. The kernel would throw too (its default `missingPrice`).
      const ratioOf = (leg: KernelLeg): number | null => {
        if (override) {
          const o = override(s, leg, m)
          if (o !== undefined) return o
        }
        if (!leg.key) return 1
        const p0 = anchors.get(leg.key) as number
        if (!(p0 > 0)) throw new Error(`census: ${s.pid} has no t0 price for ${leg.key}`)
        return priceAt(cols.get(leg.key)!, m, `${s.pid} ${leg.symbol}`) / p0
      }
      for (m = s.t0.minute + 1; m <= lastMinute; m++) {
        let live = false
        for (const k of kernels) {
          if (k.isDone) continue
          live = true
          memRecs.push(...k.step(m, ratioOf))
        }
        if (!live) break
      }
      for (const k of kernels) memRecs.push(...k.finish())
      const results: KernelResult[] = kernels.map((k) => k.result())
      if (opts.probe) {
        opts.probe({
          spec: s,
          results,
          ratioAt: (leg, minute) => {
            if (!leg.key) return 1
            const p0 = anchors.get(leg.key) as number
            if (!(p0 > 0)) throw new Error(`census: ${s.pid} has no t0 price for ${leg.key}`)
            return priceAt(cols.get(leg.key)!, minute, `${s.pid} ${leg.symbol}`) / p0
          },
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
        s.halves.length > 1
          ? s.halves.map((h, k) => ({
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
      s.halves.forEach((h, k) => {
        if (h.share > s.halves[dom].share) dom = k
      })
      const outcome: CureOutcome = results[dom].outcome
      memRow = {
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
      }
    }
    for (const r of realRecs) emit(r)
    for (const r of memRecs) emit(r)

    // ---- t0 decisions at this basis and at the other one (the price-basis residual)
    let t0Decisions: T0Decision[] | undefined
    let t0AltBasis: CensusRow['t0AltBasis']
    if (walked && s.t0 && s.ltv0 != null) {
      t0Decisions = s.halves.map((h) => t0Decision(s.ltv0!, h, MAX_THRESHOLD_TO_DELAY))
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
      t0AltBasis = {
        priceBasis: alt,
        located: altSpec.located,
        ltv0: altSpec.ltv0,
        decisions:
          altSpec.located && altSpec.ltv0 != null && altSpec.halves.length
            ? altSpec.halves.map((h) => t0Decision(altSpec.ltv0!, h, MAX_THRESHOLD_TO_DELAY))
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
      ...(walked && s.t0
        ? {
            t0: {
              block: s.t0.block,
              ts: s.t0.ts,
              minute: s.t0.minute,
              shifted: s.t0.shifted,
              priceBasis: s.t0.priceBasis,
            },
            t0Decisions,
            t0AltBasis,
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
      ltv0: s.ltv0,
      delayClass: s.delayClass,
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

  return {
    rows,
    records,
    finalTotals: state.totals,
    coverage: { ...state.coverage },
    stats,
  }
}
