// Shapes of public/data/oct10-2025/evidence-census.json, built by
// scripts/build-evidence-census.ts from the FULL on-chain census of 10-11 Oct 2025
// (membrane-datasets oct10-2025/coverage/census.json).
//
// 3,197 positions: every Aave V3 pool in the registry and every Morpho Blue market on
// Ethereum, Arbitrum, Optimism and Base, all walked. Both sides are priced by each protocol's
// own oracle, read on chain. The real side is every liquidation the position took in the
// window; Membrane's side is the contract's delay window and repay-to-cap walked minute by
// minute from the first liquidation the protocol's own health check confirms (t0), at
// MEMBRANE'S OWN LINE, with every sale capped by the liquidity the day showed (owner rulings
// 2026-10-18). The COMPARED set — the cohort and every total — is the positions with a
// Membrane line and liquidity for what Membrane sells; meta.exclusions has the rest. Only DEBT
// REPAID is compared. Every Membrane figure is MODELLED (†).
//
// The old census (public/data/oct10-2025/evidence.json, 2,347 Aave rows) is no longer read
// by any page. It is kept as a test fixture and its builder still runs.

export type ProtocolKey = 'aave-v3' | 'morpho-blue'

export interface DebtMedianBlock {
  positions: number
  realMedianFrac: number
  memMedianFrac: number
  medianDebtUsd: number
}

export interface ConcentrationEntry {
  pid: string
  protocol: ProtocolKey
  chain: string
  owner: string
  /** Real repaid minus Membrane repaid. Negative: Membrane closes more. */
  gapUsd: number
  realRepaidUsd: number
  memRepaidUsd: number
  outcome: string
}

/** One set of positions with both sides summed over the same positions. */
export interface DebtSet {
  key: string
  label: string
  positions: number
  /** Positions whose loan has a USD price: every dollar figure and median is over these. */
  pricedPositions: number
  unpricedPositions: number
  events: number
  realRepaidUsd: number
  /** Morpho only: realised bad debt, reported apart (not repaid). */
  realBadDebtUsd: number
  memRepaidUsd: number
  /** realRepaidUsd - memRepaidUsd. Positive: Membrane closes less. */
  gapUsd: number
  gapPct: number
  /** Per position, compared on the published cents. */
  less: number
  more: number
  equal: number
  /** Gross: Σ (real − Membrane) over the `less` positions, Σ (Membrane − real) over `more`. */
  lessUsd: number
  moreUsd: number
  /** Positions with no Membrane sale on any half. */
  memNeverSold: number
  /** A window still open when the data ends, booked as sold at the last price. */
  gridEnd: { positions: number; memRepaidUsd: number }
  medians: { all: DebtMedianBlock; atLeastFloor: DebtMedianBlock; floorUsd: number }
  concentration: {
    shareDenominator: string
    gapAbsoluteUsd: number
    gapPositiveUsd: number
    gapNegativeUsd: number
    top1Share: number
    top5Share: number
    top5: ConcentrationEntry[]
    gapWithoutTop1Usd: number
    gapWithoutTop1Pct: number
    gapWithoutTop5Usd: number
    gapWithoutTop5Pct: number
  }
}

/** A venue x chain row: totals only. */
export type VenueChainSet = Omit<DebtSet, 'medians' | 'concentration'> & {
  protocol: ProtocolKey
  chain: string
}

export interface DebtSummary {
  all: DebtSet
  byProtocol: Record<ProtocolKey, DebtSet>
  byVenueChain: VenueChainSet[]
}

export interface CureSummary {
  accountsAnalysed: number
  curedInWindow: number
  curedPct: number
  healthyAt8h: number
  healthyAt8hPct: number
  medianMinutesToCure: number
}

export interface Sensitivity {
  rule: string
  memRepaidUsd: number
  deltaUsd: number
  positionsChanged?: number
  positionsDecisionDiffers?: number
  byProtocol?: Record<ProtocolKey, number>
  /** Both sides over the run's own compared set. */
  set?: SetFigures
}

/** Both sides and the gross over one run's own compared set. */
export interface SetFigures {
  positions: number
  realRepaidUsd: number
  memRepaidUsd: number
  gapUsd: number
  gapPct: number
  less: number
  more: number
  lessUsd: number
  moreUsd: number
}

/** One row of the published sensitivity table (meta.sensitivities). */
export interface SensitivityRow extends SetFigures {
  key: string
  label: string
  rule: string
  headline: boolean
  byProtocol: Record<ProtocolKey, SetFigures>
  excluded: { noMembraneLine: number; partialMembraneLine: number; noCapacity: number }
}

export interface ExclusionBlock {
  positions: number
  realRepaidUsd: number
  byProtocol: Record<ProtocolKey, { positions: number; realRepaidUsd: number }>
  debtUsdAtT0: number
  top: { key: string; positions: number }[]
}

export interface CapacityBrief {
  symbol: string
  capacityTokens: number
  peakUsd: number | null
}

export interface WhaleCase {
  pid: string
  collateral: { symbol: string; amount: number; usd: number | null }[]
  debtUsd: number | null
  protocolLine: number | null
  ltv0: number | null
  realEvents: number
  realRepaidUsd: number
  headline: { memRepaidUsd: number | null; excluded: string | null } | null
  protocolLineCapped: { memRepaidUsd: number | null; excluded: string | null } | null
  protocolLineUnlimited: { memRepaidUsd: number | null; excluded: string | null } | null
  aaveMainnetCapacityTokens: number | null
  aaveMainnetLiquidatorTokens: number | null
}

export interface TimeSummary {
  /** The position's outcome (a split position: its larger half). Partitions the census. */
  outcomes: Record<string, number>
  outcomesByProtocol: Record<ProtocolKey, Record<string, number>>
  /** Per outcome, the positions with a sale on any half (the outcome is the larger half's). */
  outcomeWithSale: Record<string, number>
  /** Positions whose collateral, or one half of it, gets the 8-hour window. */
  windowPositions: number
  classes: Record<'delayed' | 'mixed' | 'no-delay', number>
  neverSold: { positions: number; debtUsd: number; realRepaidUsd: number }
  protocolSecondsGranted: number
  membraneSecondsGranted: number
  cure: CureSummary & {
    definition: string
    byProtocol: Record<ProtocolKey, CureSummary>
    noDelay: { accounts: number; wouldHaveCuredWithWindow: number }
  }
  oneRepay: {
    /** Both sides without the liquidity cap (one repay vs the unlimited walk). */
    basis: string
    memOneRepayUsd: number
    memWalkUnlimitedUsd: number
    delayCreditUsd: number
    byProtocol: Record<ProtocolKey, { memOneRepayUsd: number; delayCreditUsd: number }>
    cureCreditUsd: number
    cureCreditShareWithin2min: number
    cureCreditShareWithin1h: number
    cureCreditShareWithin8h: number
    cureCreditGrossUsd: number
    counterCreditUsd: number
    counterCreditPositions: number
  }
  freshPrints: {
    chain: string
    symbol: string
    source: string
    minutes: number
    gridMinutes: number
  }
  bandSensitivity: { band: number; memRepaidUsd: number; byProtocol: Record<ProtocolKey, number> }[]
  sensitivity: {
    noEarlyClear: Sensitivity
    noDebtFloor: Sensitivity
    singleSale: Sensitivity
    noWalkOnAfterT0BandSale: Sensitivity
    t0PriceBasis: Sensitivity
  }
}

export interface AssetSummary {
  symbol: string
  positions: number
  aave: number
  morpho: number
  realRepaidUsd: number
  memRepaidUsd: number
  realMedianFrac: number
  memMedianFrac: number
  /** Share cured in the 8h window (no window counts as not cured); null when no cure record. */
  curedPct: number | null
}

export interface EvidenceMeta {
  schema: string
  generatedBy: string
  source: {
    path: string
    schema: string
    bytes: number
    sha256: string
    builtBy: string
    /** census.meta.totals as the census states them: 'all', each protocol, each venue x chain. */
    totals: Record<
      string,
      {
        positions: number
        events: number
        realRepaidUsd: number
        memRepaidUsd: number
        positionsKept: number
        positionsSoldAtGridEnd: number
      }
    >
    outcomes: Record<string, number>
  }
  code: { commit: string; dirty: boolean; paths: string[]; note: string }
  window: { from: string; to: string; label: string; minutes: number; stepSeconds: number }
  scope: {
    line: string
    inScope: string
    venues: { chain: string; venue: string; name: string; events: number }[]
    outOfScope: string
  }
  oracle: string
  /** The COMPARED positions: every total and cohort row is over these. */
  positions: number
  walked: number
  /** Every position the census holds. */
  censusPositions: number
  exclusions: {
    rule: string
    noMembraneLine: ExclusionBlock
    noCapacity: ExclusionBlock
    partialLine: {
      rule: string
      positions: number
      realRepaidUsd: number
      unknownCollateralUsdAtT0: number
    }
  }
  line: { rule: string; source: string }
  liquidity: {
    rule: string
    multiplier: number
    multiplierBasis: string
    windowMinutes: number
    topByChain: Record<string, CapacityBrief[]>
    tokens: number
    positionsShortFilled: number
    unfilledAtGridEndUsd: number
    whale: WhaleCase
  }
  sensitivities: SensitivityRow[]
  events: number
  chains: string[]
  params: {
    band: number
    delaySeconds: number
    borrowLtvGap: number
    liqDebtMinimumUsd: number
    maxSales: number
    lineMode: string
    capacityMultiplier: number
    capacityWindowMinutes: number
  }
  realConstants: {
    borrowLtvGapSource: string
    repayFormulaSource: string
    cureWindowSource: string
    liqDebtMinimumSource: string
    debtMinimumRuleSource: string
  }
  method: string
  sameSet: string
  unpriced: { positions: number; loanSymbols: string[]; realEvents: number; memSales: number }
  gridEnd: {
    positions: number
    positionsFirstSoldThere: number
    memRepaidUsd: number
    byProtocol: Record<ProtocolKey, { positions: number; memRepaidUsd: number }>
    rule: string
  }
  /** The old 747-row priced subset, kept ONLY to explain why its 36% moved. Superseded. */
  crossCheck: {
    label: string
    rows: number
    old: { realRepaidUsd: number; memRepaidUsd: number }
    new: { realRepaidUsd: number; memRepaidUsd: number }
    factors: Record<string, number>
    interactionAndResidualUsd: number
    allFactorsToggledUsd: number
    allFactorsToggledVsOldUsd: number
    line: string
  }
  /** Rendered verbatim in the UI. These are not footnotes to bury. */
  caveats: string[]
}

export interface CureRecord {
  curedInWindow: boolean
  healthyAt8h: boolean
  /** Minutes from t0 to the lowest LTV in the window, when that is under the line. */
  minutesToCure: number | null
  bestLtv: number
  endLtv: number
  /** No window (stablecoin collateral or a line above 90%): never counted cured. */
  noWindow: boolean
  wouldHaveCuredWithWindow: boolean
}

/** One liquidated position. The unit the cohort table traverses. */
export interface CohortRow {
  /** Stable key: protocol, chain, market, owner (and Morpho market id). */
  id: string
  protocol: 'aave' | 'morpho'
  chain: string
  /** Aave 'core' | 'lido'; Morpho 'blue'. */
  market: string
  owner: string
  /** Morpho market id; null for Aave. */
  marketId: string | null
  /** How many separate times the protocol liquidated this position in the window. */
  events: number
  /** Grid minute of t0 (minute 0 = 00:00 UTC 10 Oct 2025). */
  t0Minute: number
  /** Collateral and debt legs at t0, largest first: [symbol, USD at t0 (null: unpriced)]. */
  coll: [string, number | null][]
  debt: [string, number | null][]
  collUsd: number | null
  debtUsd: number | null
  /** The line Membrane walks it at: Membrane's own (modelled †). */
  line: number
  /** The protocol's own liquidation line (Aave: weighted LT; Morpho: LLTV). */
  protocolLine: number
  ltv0: number
  delayClass: 'no-delay' | 'delayed' | 'mixed'
  /** Largest collateral leg at t0. */
  primary: string
  cluster: string
  /** The loan has a USD price, so the position is in every dollar figure. */
  priced: boolean
  realRepaidUsd: number
  realBadDebtUsd: number
  /** MODELLED (†). */
  memRepaidUsd: number
  /** The same walk without the liquidity cap (†): the delay credit's basis. */
  memUnlimitedUsd: number
  /** Real repaid over the t0 debt. Can exceed 1: new borrowing and interest. */
  realFrac: number | null
  /** Debt Membrane closes, on the t0 basis, over the t0 debt (†). */
  memFrac: number | null
  outcome: string
  sales: number
  firstSaleMinute: number | null
  /** Set when a window was still open at the data end; the USD booked there (†). */
  gridEndUsd: number | null
  minutesToFirstCure: number | null
  /** One repay to cap at t0 with no window, USD at t0 (†); null when the loan is unpriced. */
  oneRepayUsd: number | null
  cure: CureRecord | null
}

/** The served file as it is on disk: the cohort is columnar. */
export interface EvidenceFile {
  meta: EvidenceMeta
  debt: DebtSummary
  time: TimeSummary
  byAsset: AssetSummary[]
  landing: Record<string, unknown>
  cohort: {
    columns: string[]
    cureColumns: string[]
    legColumns: string[]
    rows: unknown[][]
  }
}

/** What the page works with: the same document, cohort decoded into rows. */
export interface EvidenceDoc extends Omit<EvidenceFile, 'cohort'> {
  cohort: CohortRow[]
}

export type Lens = 'debt' | 'time' | 'cohort'

/** Sort keys the cohort table offers. */
export type SortKey = 'debtUsd' | 'spared' | 'events' | 'ltv0'

/** Outcome filter for the cohort table. */
export type OutcomeFilter =
  | 'all'
  | 'membraneLess'
  | 'membraneMore'
  | 'equal'
  | 'cured'
  | 'notCured'
  | 'gridEnd'

/** Protocol filter for the cohort table. */
export type ProtocolFilter = 'all' | 'aave' | 'morpho'

/** USD spared: what the protocol repaid minus what Membrane would have. Null when unpriced. */
export function sparedUsd(r: CohortRow): number | null {
  return r.priced ? r.realRepaidUsd - r.memRepaidUsd : null
}

/** The per-position comparison, on the published cents (the builder's own rule). */
export function compareRow(r: CohortRow): 'less' | 'more' | 'equal' | 'unpriced' {
  if (!r.priced) return 'unpriced'
  const m = Math.round(r.memRepaidUsd * 100)
  const a = Math.round(r.realRepaidUsd * 100)
  return m < a ? 'less' : m > a ? 'more' : 'equal'
}

/** Decode the served file's columnar cohort. Pure; throws on a column it does not know. */
export function decodeEvidence(file: EvidenceFile): EvidenceDoc {
  const { columns, cureColumns, rows } = file.cohort
  const at = (name: string) => {
    const i = columns.indexOf(name)
    if (i < 0) throw new Error(`evidence-census: no column ${name}`)
    return i
  }
  const c = Object.fromEntries(
    [
      'protocol',
      'chain',
      'market',
      'owner',
      'marketId',
      'events',
      't0Minute',
      'coll',
      'debt',
      'collUsd',
      'debtUsd',
      'line',
      'protocolLine',
      'ltv0',
      'delayClass',
      'primary',
      'cluster',
      'priced',
      'realRepaidUsd',
      'realBadDebtUsd',
      'memRepaidUsd',
      'memUnlimitedUsd',
      'realFrac',
      'memFrac',
      'outcome',
      'sales',
      'firstSaleMinute',
      'gridEndUsd',
      'minutesToFirstCure',
      'oneRepayUsd',
      'cure',
    ].map((k) => [k, at(k)]),
  ) as Record<string, number>
  const k = (name: string) => {
    const i = cureColumns.indexOf(name)
    if (i < 0) throw new Error(`evidence-census: no cure column ${name}`)
    return i
  }
  const kc = {
    cured: k('curedInWindow'),
    healthy: k('healthyAt8h'),
    minutes: k('minutesToCure'),
    best: k('bestLtv'),
    end: k('endLtv'),
    noWindow: k('noWindow'),
    would: k('wouldHaveCuredWithWindow'),
  }
  const cohort: CohortRow[] = rows.map((v) => {
    const cure = v[c.cure] as (number | null)[] | null
    const protocol = v[c.protocol] as 'aave' | 'morpho'
    const marketId = (v[c.marketId] as string | null) ?? null
    return {
      id: `${protocol}:${v[c.chain]}:${v[c.market]}:${v[c.owner]}${marketId ? `:${marketId}` : ''}`,
      protocol,
      chain: v[c.chain] as string,
      market: v[c.market] as string,
      owner: v[c.owner] as string,
      marketId,
      events: v[c.events] as number,
      t0Minute: v[c.t0Minute] as number,
      coll: v[c.coll] as [string, number | null][],
      debt: v[c.debt] as [string, number | null][],
      collUsd: v[c.collUsd] as number | null,
      debtUsd: v[c.debtUsd] as number | null,
      line: v[c.line] as number,
      protocolLine: v[c.protocolLine] as number,
      ltv0: v[c.ltv0] as number,
      delayClass: v[c.delayClass] as CohortRow['delayClass'],
      primary: v[c.primary] as string,
      cluster: v[c.cluster] as string,
      priced: v[c.priced] === 1,
      realRepaidUsd: v[c.realRepaidUsd] as number,
      realBadDebtUsd: v[c.realBadDebtUsd] as number,
      memRepaidUsd: v[c.memRepaidUsd] as number,
      memUnlimitedUsd: v[c.memUnlimitedUsd] as number,
      realFrac: v[c.realFrac] as number | null,
      memFrac: v[c.memFrac] as number | null,
      outcome: v[c.outcome] as string,
      sales: v[c.sales] as number,
      firstSaleMinute: v[c.firstSaleMinute] as number | null,
      gridEndUsd: v[c.gridEndUsd] as number | null,
      minutesToFirstCure: v[c.minutesToFirstCure] as number | null,
      oneRepayUsd: v[c.oneRepayUsd] as number | null,
      cure: cure
        ? {
            curedInWindow: cure[kc.cured] === 1,
            healthyAt8h: cure[kc.healthy] === 1,
            minutesToCure: cure[kc.minutes],
            bestLtv: cure[kc.best] as number,
            endLtv: cure[kc.end] as number,
            noWindow: cure[kc.noWindow] === 1,
            wouldHaveCuredWithWindow: cure[kc.would] === 1,
          }
        : null,
    }
  })
  return { ...file, cohort }
}

/** The summary the server renders: everything but the cohort (a few KB). */
export function summaryOf(file: EvidenceFile): EvidenceDoc {
  const { cohort: _cohort, ...rest } = file
  return { ...rest, cohort: [] }
}
