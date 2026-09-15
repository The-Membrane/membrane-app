// Shapes of public/data/oct10-2025/evidence.json, emitted by the offline
// counterfactual build (scratchpad `build_evidence.py`).
//
// Every figure here is derived from 3,111 real Aave liquidation events in the
// Oct 10-11 2025 window. Membrane's side uses only mechanisms the protocol docs
// mark REAL -- the partial repay-to-cap formula, the 3pp borrow gap, and the 8h
// cure window. The modelled per-asset LTV is deliberately never used: each
// account is judged against its own liquidation line, inverted from its measured
// health factor.

export interface EvidenceMeta {
  window: string
  sourceEvents: number
  accounts: number
  unpricedEventsDropped: number
  provenance: string
  method: string
  realConstants: {
    borrowLtvGap: number
    borrowLtvGapSource: string
    repayFormulaSource: string
    cureWindowSeconds: number
    cureWindowSource: string
    liqDebtMinimumUsd: number
    liqDebtMinimumSource: string
    debtMinimumRuleSource: string
  }
  /** Rows whose breach could not be located even after the rebase. Dropped both sides. */
  excluded: {
    accounts: number
    aaveClosedUsd: number
    membraneOneRepayUsd: number
    reason: string
    rebasedIntoBreach: number
  }
  /** What each collateral symbol was priced through, and each proxy's exposure. */
  collateralMapping: {
    ethProxy: { symbols: string[]; accounts: number; debtUsd: number; note: string }
    multiCollateral: { accounts: number; debtUsd: number; note: string }
    debtLegRatio: { accounts: number; debtUsd: number; note: string }
    freshOraclePrints: { ethOracle: number; btcOracle: number; minutes: number }
  }
  /** Corners the model does not take, priced rather than argued. */
  sensitivity: {
    noEarlyClearMembraneClosedUsd: number
    noEarlyClearDeltaUsd: number
    noDebtFloorMembraneClosedUsd: number
    debtFloorDeltaUsd: number
    debtFloorAccountsChanged: number
    debtFloorOneRepayAccountsChanged: number
    singleSaleMembraneClosedUsd: number
    repeatSaleDeltaUsd: number
    repeatSaleAccounts: number
    maxSalesSeen: number
    withExcludedAaveClosedUsd: number
    withExcludedMembraneClosedUsd: number
  }
  cohortRows: number
  /**
   * The delay window as it was MODELLED, not as it was diagnosed. Every Membrane
   * dollar in this document comes out of `lib/position-sim/curePath.ts` cureWalk run
   * with these parameters. `membraneOneRepayUsd` is the older one-repay-per-account
   * figure, kept so the window's contribution is a visible subtraction.
   */
  cureModel: CureModel
  /** Rendered verbatim in the UI. These are not footnotes to bury. */
  caveats: string[]
}

export interface CureModel {
  engine: string
  delaySeconds: number
  band: number
  borrowLtvGap: number
  debtMinimumUsd: number
  maxSales: number
  stepSeconds: number
  /** Clause-by-clause contract citations for what the walk implements. */
  semantics: string[]
  /** How many accounts ended in each `CureOutcome`. Partitions the cohort. */
  outcomes: Record<string, number>
  /** Closed USD at other values of `max_threshold_to_delay`. The band is the guarantee. */
  bandSensitivity: { band: number; membraneClosedUsd: number }[]
  membraneOneRepayUsd: number
  /** membraneOneRepayUsd - the walked total. */
  delayCreditUsd: number
  cureCreditUsd: number
  cureCreditShareWithin2min: number
  cureCreditShareWithin1h: number
  cureCreditShareWithin8h: number
  /** Gross credit, and the counter-credit from accounts the deferred sale cost more. */
  cureCreditGrossUsd: number
  counterCreditUsd: number
  counterCreditAccounts: number
  /** The median up-move a fast-curing position needed on its collateral leg, in %. */
  medianRequiredUpMoveFastCurePct: number
  medianRequiredUpMoveAllPct: number
  fastCureAccounts: number
  /** Minutes in the window where the ETH oracle printed a fresh round (183 of 2,880). */
  freshEthPrints: number
  gridMinutes: number
  /** Aave minus Membrane, per outcome bucket. Where the headline gap actually lives. */
  gapByOutcome: Record<
    string,
    {
      accounts: number
      aaveClosedUsd: number
      membraneClosedUsd: number
      gapUsd: number
    }
  >
  concentration: {
    netGapUsd: number
    gapPositiveUsd: number
    gapNegativeUsd: number
    shareDenominator: string
    top1Share: number
    top5Share: number
    top1Account: string | null
    top1GapUsd: number
  }
  /** After the rebase every included row has a located line, so this IS the headline. */
  locatedLineOnly: {
    accounts: number
    aaveClosedUsd: number
    membraneOneRepayUsd: number
    membraneClosedUsd: number
  }
}

/** One complete headline set: the same fields, over a stated subset of the census. */
export interface HeadlineSet {
  label: string
  note: string
  accounts: number
  aaveClosedUsd: number
  membraneOneRepayUsd: number
  membraneClosedUsd: number
  gapUsd: number
  gapPct: number
  delayCreditUsd: number
  membraneClosesLess: number
  membraneClosesMore: number
  aaveMedianFrac: number
  membraneMedianFrac: number
  medians: {
    allAccounts: MedianBlock
    debtAtLeastFloor: MedianBlock
    floorUsd: number
  }
  concentration: {
    shareDenominator: string
    gapAbsoluteUsd: number
    top1Share: number
    top5Share: number
    top1Account: string | null
    top1AbsGapUsd: number
    top5Accounts: string[]
  }
}

export interface MedianBlock {
  accounts: number
  aaveMedianFrac: number
  membraneMedianFrac: number
  medianDebtUsd: number
}

/**
 * How much of each account's debt the two engines close. Path-independent.
 *
 * The flat fields ARE `priced` — the accounts whose collateral has a price series, so the
 * whole model (break band, minute walk, cure, re-arm) applies to them. `allIncluded` adds
 * back the accounts with no collateral series: those take one repay and can never cure, so
 * they import the repay-to-cap upper bound with none of the delay window attached. Both
 * are published so a reader is never handed one of the two without the other.
 */
export interface DebtSummary {
  accounts: number
  aaveClosedUsd: number
  membraneClosedUsd: number
  differenceUsd: number
  differencePct: number
  aaveMedianFrac: number
  membraneMedianFrac: number
  membraneClosesLess: number
  /** Shown, never hidden. Membrane is worse on these. */
  membraneClosesMore: number
  priced: HeadlineSet
  allIncluded: HeadlineSet
}

/** What the real 8h cure window would have done. PATH-DEPENDENT -- see caveats. */
export interface TimeSummary {
  accountsAnalysed: number
  curedInWindow: number
  curedPct: number
  healthyAt8h: number
  healthyAt8hPct: number
  medianMinutesToCure: number
  aaveSecondsGranted: number
  membraneSecondsGranted: number
}

export interface AssetSummary {
  accounts: number
  aaveMedianFrac: number
  membraneMedianFrac: number
  curedPct: number | null
}

export interface CureRecord {
  curedInWindow: boolean
  healthyAt8h: boolean
  minutesToCure: number | null
  bestLtv: number
  endLtv: number
}

/** One real liquidated account. The unit the cohort table traverses. */
export interface CohortRow {
  chain: string
  user: string
  /** How many separate times the source protocol liquidated this account. */
  events: number
  /** Grid index of t0 in prices-1m.json. `closedAtIndex` is relative to this. */
  t0Index: number
  t0Ts: number
  /** MODELLED basis: the block-1 snapshot rebased to the liquidation-minute print. */
  collateralUsd: number
  debtUsd: number
  /** What the enriched CSV read at block_number-1, before the rebase. */
  snapshotCollateralUsd: number
  snapshotDebtUsd: number
  /** p(t0)/p(t0-1) on each leg. 1 when that minute's oracle round was carried. */
  rebaseColl: number
  rebaseDebt: number
  healthFactor: number
  /** This account's own liquidation line, inverted from its health factor. */
  liqLine: number
  ltv0: number
  /** The pre-rebase LTV, from the block-1 snapshot alone. */
  ltv0Snapshot: number
  /**
   * Still not breached after the rebase: a state/event mismatch the data cannot
   * resolve. Excluded from BOTH sides of every summary total, kept here so the table
   * can still show the row.
   */
  excluded: boolean
  collSymbol: string
  debtSymbol: string
  aaveClosedUsd: number
  membraneClosedUsd: number
  aaveClosedFrac: number
  membraneClosedFrac: number
  /** What ONE repay to cap at t0 would have closed — the pre-window figure. */
  membraneOneRepayUsd: number
  /** Which branch of the delay window this account ended on. See curePath.ts. */
  outcome: string
  /** Grid minute the sale landed on, or null when nothing was ever sold. */
  closedAtIndex: number | null
  /** Minutes from t0 to the first minute back under the line, or null. */
  minutesToFirstCure: number | null
  /** How many separate times the account crossed above its own line. */
  breaches: number
  /** How many separate sales ran. A repay restores the cap, so the position re-arms. */
  sales: number
  /**
   * The earlier BEST-LTV diagnostic over a fixed 8h look-ahead. It is NOT the walk —
   * it ignores the band and ignores re-arming, and no dollar is computed from it.
   * null when the collateral leg is not priceable by the Oct 10 oracle series.
   */
  cure: CureRecord | null
}

export interface EvidenceDoc {
  meta: EvidenceMeta
  debt: DebtSummary
  time: TimeSummary
  byAsset: Record<string, AssetSummary>
  cohort: CohortRow[]
}

export type Lens = 'debt' | 'time' | 'cohort'

/** Sort keys the cohort table offers. */
export type SortKey = 'debtUsd' | 'spared' | 'events' | 'ltv0'

/** Outcome filter for the cohort table. */
export type OutcomeFilter = 'all' | 'membraneLess' | 'membraneMore' | 'cured' | 'notCured'

/** USD spared: what Aave closed minus what Membrane would have. Can be negative. */
export function sparedUsd(r: CohortRow): number {
  return r.aaveClosedUsd - r.membraneClosedUsd
}
