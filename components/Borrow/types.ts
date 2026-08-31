/**
 * Shared types for the Borrow feature (ported from public/proto/borrow.html).
 */

/** A wallet-held collateral asset the page offers to post. */
export interface CollateralAsset {
  /** Display symbol, e.g. 'WBTC'. Also the key used by the oracle-card lookup. */
  sym: string
  /** Wallet balance, in asset units. */
  bal: number
  /** Oracle price, USD. */
  px: number
  /** Decimal places to show for this asset's amounts. */
  dp: number
  /** Yield earned while posted as collateral, in percent/yr (0 = none). */
  yld: number
  /** Borrow cap — the max LTV a user can draw to, as a fraction (0.60 = 60%). */
  B: number
  /** Liquidation line — the LTV at which a breach opens the cure window, as a fraction. */
  M: number
  /** Realized 12-month annualized volatility, as a fraction (0.343 = 34.3%). */
  vol: number
}

/** Emphasis kind for inline oracle-card copy, mirrors the proto's <b class="X"> spans. */
export type EmphasisKind = 'does' | 'not' | 'mut'

/** One row of a confirm-sheet ([label, value] pair), matching window.__exec's `rows`. */
export type ExecRow = [label: string, value: string]

/** Payload for the mock execution confirm-sheet, ported from window.__exec(o). */
export interface ExecSheetData {
  title: string
  rows: ExecRow[]
  note?: string
  cta?: string
  done?: string
}

/** Risk tag rendered on an oracle info card, e.g. 'medium (AOR-2 · route depth)'. */
export interface OracleTag {
  variant: 'med' | 'plan'
  label: string
}

/** Oracle info-card content for one asset, ported from the O map in borrow.html. */
export interface OracleCardEntry {
  sym: string
  tag: OracleTag
  summary: string
  bullets: string[]
  /** Optional callout box (amber "owire" block in the proto), e.g. model caveats. */
  wire?: string
}

/** Phases of the mock chain choreography inside the confirm sheet. */
export type ExecPhase = 'confirm' | 'signing' | 'pending' | 'done'
