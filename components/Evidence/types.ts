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
  }
  /** Rendered verbatim in the UI. These are not footnotes to bury. */
  caveats: string[]
}

/** How much of each account's debt the two engines close. Path-independent. */
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
  collateralUsd: number
  debtUsd: number
  healthFactor: number
  /** This account's own liquidation line, inverted from its health factor. */
  liqLine: number
  ltv0: number
  collSymbol: string
  debtSymbol: string
  aaveClosedUsd: number
  membraneClosedUsd: number
  aaveClosedFrac: number
  membraneClosedFrac: number
  /** null when the collateral leg is not priceable by the Oct 10 oracle series. */
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
