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
  /** Its contribution to the net share gap, percentage points. Negative: Membrane closes more. */
  gapPp: number
  realFrac: number
  memFrac: number
  outcome: string
}

/** Both shares over one side of the per-position split. */
export interface ShareSplit {
  positions: number
  realShare: number
  memShare: number
}

/**
 * The share of debt closed over a set (owner ruling 2026-10-18, second round): each side's
 * repaid debt over ITS OWN t0 debt (Membrane's is sized to its line), debt-weighted over the
 * priced positions. The two sides carry different debt, so no Membrane dollar is set beside
 * a real one; `realRepaidUsd` is the size of the day on the set.
 */
export interface ShareFigures {
  positions: number
  /** Positions whose loan has a USD price: every share and median is over these. */
  pricedPositions: number
  realRepaidUsd: number
  realDebtUsd: number
  /** Membrane's own t0 debt, sized to its line (†). */
  memDebtUsd: number
  realShare: number
  memShare: number
  /** (real − Membrane) in percentage points. Positive: Membrane closes a smaller share. */
  gapPp: number
  /** Per position, the two shares compared at 1e-5. */
  less: number
  more: number
  equal: number
  /** Both shares over each side of that split: what the net is made of. */
  lessSet: ShareSplit
  moreSet: ShareSplit
}

/** One set of positions with both sides over the same positions. */
export interface DebtSet extends ShareFigures {
  key: string
  label: string
  unpricedPositions: number
  events: number
  /** Morpho only: realised bad debt, reported apart (not repaid). */
  realBadDebtUsd: number
  /** Positions with no Membrane sale on any half. */
  memNeverSold: number
  /** A window still open when the data ends, booked as sold at the last price. */
  gridEnd: { positions: number; memShare: number }
  medians: { all: DebtMedianBlock; atLeastFloor: DebtMedianBlock; floorUsd: number }
  concentration: {
    shareDenominator: string
    gapAbsolutePp: number
    top1Share: number
    top5Share: number
    top5: ConcentrationEntry[]
    gapWithoutTop1Pp: number
    gapWithoutTop5Pp: number
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
  /** Membrane's share of its own t0 debt closed, over the run's own set. */
  memShare: number
  gapPp: number
  positionsChanged?: number
  positionsDecisionDiffers?: number
  byProtocol?: Record<ProtocolKey, number>
  /** Both sides over the run's own compared set. */
  set?: SetFigures
}

/** Both sides over one run's own compared set, with the split. */
export type SetFigures = ShareFigures

/** One row of the published sensitivity table (meta.sensitivities). */
export interface SensitivityRow extends SetFigures {
  key: string
  label: string
  rule: string
  headline: boolean
  byProtocol: Record<ProtocolKey, ShareFigures>
  excluded: { noMembraneLine: number; partialMembraneLine: number; noCapacity: number }
}

export interface ExclusionBlock {
  positions: number
  realRepaidUsd: number
  byProtocol: Record<ProtocolKey, { positions: number; realRepaidUsd: number }>
  debtUsdAtT0: number
  /** By main collateral (no-capacity: by chain:token it would sell). */
  top: { key: string; positions: number; realRepaidUsd: number }[]
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
  headline: WhaleRun | null
  /** At the protocol's own line, on the REAL debt (no sizing): dollars compare there. */
  protocolLineCapped: WhaleRun | null
  protocolLineUnlimited: WhaleRun | null
  aaveMainnetCapacityTokens: number | null
  aaveMainnetLiquidatorTokens: number | null
}

export interface WhaleRun {
  memRepaidUsd: number | null
  memFrac: number | null
  excluded: string | null
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
  bandSensitivity: {
    band: number
    memShare: number
    byProtocol: Record<ProtocolKey, number>
    set: ShareFigures
  }[]
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
  realShare: number
  memShare: number
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
        realShare: number
        memShare: number
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
    /** Some collateral has no Membrane line: excluded (owner ruling 2026-10-18). */
    partialMembraneLine: ExclusionBlock
    noCapacity: ExclusionBlock
  }
  line: {
    rule: string
    source: string
    /** How Membrane's debt is sized to its line, over the compared set (review 2026-10-18). */
    sizing: {
      rule: string
      positions: number
      scaledDown: number
      scaledUp: number
      scaledUpHoldingStables: number
      unchanged: number
      minScale: number
      maxScale: number
      splits: number
      splitsWithAHalfUnderItsLine: number
    }
  }
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
    /** Membrane's closed debt booked at the grid end, as a share of its t0 debt (†). */
    memShare: number
    byProtocol: Record<ProtocolKey, { positions: number; memShare: number }>
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
  /** Membrane's t0 debt, sized to its line (†). */
  memDebtUsd: number | null
  /** MODELLED (†): Membrane's own dollars, on its own debt. Never set beside realRepaidUsd. */
  memRepaidUsd: number
  /** The same walk without the liquidity cap (†): the delay credit's basis. */
  memUnlimitedUsd: number
  /** Real repaid over the t0 debt. Can exceed 1: new borrowing and interest. */
  realFrac: number | null
  /** Debt Membrane closes, on the t0 basis, over ITS OWN (line-sized) t0 debt (†). */
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

/**
 * Share spared, in percentage points: the share of its debt the protocol closed minus the
 * share of ITS OWN (line-sized) debt Membrane would have. Null when unpriced.
 */
export function sparedPp(r: CohortRow): number | null {
  return r.priced && r.realFrac != null && r.memFrac != null ? (r.realFrac - r.memFrac) * 100 : null
}

/** The per-position comparison of the two SHARES at the published 1e-5 (the builder's rule). */
export function compareRow(r: CohortRow): 'less' | 'more' | 'equal' | 'unpriced' {
  if (!r.priced || r.realFrac == null || r.memFrac == null) return 'unpriced'
  const m = Math.round(r.memFrac * 1e5)
  const a = Math.round(r.realFrac * 1e5)
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
      'memDebtUsd',
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
      memDebtUsd: v[c.memDebtUsd] as number | null,
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
