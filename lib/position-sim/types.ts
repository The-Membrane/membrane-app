/**
 * Shared types for the position simulator.
 *
 * DATA HONESTY: every number that reaches the screen carries a `Provenance` stamp.
 * There is no unstamped path. `kind` is the whole point:
 *   - 'onchain'   read live from a node this session
 *   - 'dataset'   read from a committed, measured file under public/data
 *   - 'modelled'  computed by us from stamped inputs — a model, not an observation
 *   - 'mock'      fixture data, shown only where it is labelled as such
 */

export type ProtocolId = 'aave-v3' | 'spark' | 'morpho-blue' | 'compound-v3' | 'fluid'

export type ProvenanceKind = 'onchain' | 'dataset' | 'modelled' | 'mock'

export interface Provenance {
  kind: ProvenanceKind
  /** Short human label, e.g. 'aave v3' or 'measured Oct 10 2025 · 1m candles'. */
  label: string
  /** Epoch ms when this was obtained. Rendered as `· fetched HH:MM`. */
  at: number
  /** Optional extra detail shown on hover / in the receipt. */
  detail?: string
  /** The block every on-chain call of the read was pinned to, when one was. */
  block?: number
}

export const stamp = (
  kind: ProvenanceKind,
  label: string,
  detail?: string,
  at: number = Date.now(),
): Provenance => ({ kind, label, at, detail })

/** One collateral asset inside a position. */
export interface CollateralLeg {
  symbol: string
  address: string
  decimals: number
  /** Human units (already scaled out of wei). */
  amount: number
  /** USD price at read time, as the SOURCE PROTOCOL's own oracle reported it. */
  priceUsd: number
  valueUsd: number
  /** The source protocol's liquidation threshold for this asset, 0–1. */
  liquidationThreshold: number
  /** The source protocol's max borrow LTV for this asset, 0–1. */
  maxLtv: number
  /**
   * The liquidator's bonus on this asset as a fraction of the repaid value
   * (Aave 10500 bps -> 0.05). This is the value the position actually loses on top
   * of the debt repaid, so it must be read, never assumed. `null` when the protocol
   * does not expose one — the caller must then say so rather than substitute a value.
   */
  liquidationBonus: number | null
}

/** One borrowed asset inside a position. */
export interface DebtLeg {
  symbol: string
  address: string
  decimals: number
  amount: number
  priceUsd: number
  valueUsd: number
  /** Borrow APR at read time if the protocol exposes it, else null. Never guessed. */
  borrowApr: number | null
}

/**
 * An asset the address LENDS into a market (Morpho Blue supply). It is not collateral: no
 * borrow is secured by it, so it has no liquidation line and no line is computed on it.
 * It is NOT beyond loss: when a borrower's liquidation leaves bad debt, Morpho writes it
 * off against the market's supply, so every lender in that market shares it.
 */
export interface SuppliedLeg {
  symbol: string
  address: string
  decimals: number
  amount: number
  priceUsd: number
  valueUsd: number
}

/**
 * What the address holds in one position, where an adapter states it:
 *   'borrowing'        it owes debt here — the only case with a liquidation line
 *   'collateral-only'  collateral posted, nothing borrowed
 *   'supply-only'      it only lends into the market: no collateral, no debt
 */
export type PositionStatus = 'borrowing' | 'collateral-only' | 'supply-only'

/**
 * A check of the source protocol's own collateral price against an independent market
 * reference (Morpho Blue: the market oracle against the Aave V3 oracle, else DefiLlama).
 *   'ok'         the oracle's USD price is within `band` × the reference
 *   'disagrees'  it is outside the band: the oracle's price is not the market's
 *   'unchecked'  no reference price was found to check it against
 * Anything but 'ok' means the line exists only in the oracle's own terms: no forecast,
 * no chances and no alert price may be built on it.
 */
export interface OracleCheck {
  status: 'ok' | 'disagrees' | 'unchecked'
  /** The collateral token, and the token the oracle quotes it in (Morpho: the loan token). */
  symbol: string
  quote: string
  /** The oracle's price: `quote` tokens per collateral token, and that in USD. */
  oraclePrice: number
  oraclePriceUsd: number
  /** The reference USD price and where it came from; null when none was found. */
  referenceUsd: number | null
  referenceSource: string | null
  /** oraclePriceUsd / referenceUsd; null without a reference. */
  ratio: number | null
  band: { min: number; max: number }
}

/** A single position on a single protocol. */
export interface ProtocolPosition {
  protocol: ProtocolId
  /** Human label, e.g. 'Aave V3' or 'Morpho · wstETH/USDC 86%'. */
  label: string
  /** Morpho market id / Comet address / undefined for pooled protocols. */
  marketId?: string
  collateral: CollateralLeg[]
  debt: DebtLeg[]
  totalCollateralUsd: number
  totalDebtUsd: number
  /** debt / collateral. */
  ltv: number
  /** Collateral-weighted liquidation threshold — the line this position dies at. */
  liquidationLtv: number
  /** Protocol's own health factor where it exposes one, else derived. */
  healthFactor: number
  provenance: Provenance
  /** Set by adapters that can hold a position with no debt (Morpho Blue). Unset = not stated. */
  status?: PositionStatus
  /** Assets lent into this market, when the adapter reads them. Never part of a line. */
  supplied?: SuppliedLeg[]
  /** The collateral oracle checked against a market reference, where the adapter does it. */
  oracleCheck?: OracleCheck
}

/**
 * 'incomplete': the adapter read every market it could FIND and none held a position, but
 * it could not find every market (Morpho Blue has no on-chain index of an address's
 * markets; see `MarketDiscovery`). Different from 'empty': a position may exist that was
 * never checked, so the page must not say "no position found".
 */
export type AdapterStatus = 'ok' | 'empty' | 'incomplete' | 'error' | 'unsupported'

/**
 * How an adapter found the markets it read, for a protocol whose positions cannot be
 * enumerated on-chain. `complete: false` means markets outside `source` were not checked.
 */
export interface MarketDiscovery {
  complete: boolean
  /** Where the market list came from, e.g. "Morpho API" or "known-market list". */
  source: string
  /** Markets whose on-chain position was read. */
  checked: number
  /** Why discovery is incomplete (an API failure, a cap), shown verbatim. */
  reason?: string
}

/** Each adapter fails independently — one broken protocol never blanks the page. */
export interface AdapterResult {
  protocol: ProtocolId
  label: string
  status: AdapterStatus
  positions: ProtocolPosition[]
  /** Plain-language reason when status is 'error', 'incomplete' or 'unsupported'. Shown verbatim. */
  message?: string
  /**
   * Sub-markets (one Comet) a sanity check dropped from an otherwise good read, each with
   * its reason. Shown verbatim; the rest of the read stands.
   */
  skipped?: { market: string; reason: string }[]
  /** How the markets were found, where the protocol cannot enumerate them (Morpho Blue). */
  discovery?: MarketDiscovery
  fetchedAt: number
  /** Milliseconds the read took, for the receipt. */
  tookMs?: number
}

// ---------------------------------------------------------------- simulation

/** A measured price path: one series per asset symbol, aligned to a minute grid. */
export interface PricePath {
  startTs: number
  stepSeconds: number
  count: number
  /** symbol -> per-minute price in USD. `null` = a genuine gap, never filled. */
  series: Record<string, (number | null)[]>
  provenance: Provenance
}

export type LiquidationEngineId = 'source' | 'membrane'

/** One liquidation (or cure) event in a run. */
export interface SimEvent {
  /** Index into the price path. */
  minute: number
  ts: number
  kind: 'liquidation' | 'cure' | 'recall' | 'breach' | 'frozen'
  /** LTV at the moment the event fired. */
  ltv: number
  /** The line that was crossed. */
  line: number
  /** USD of debt repaid by this event. */
  repaidUsd: number
  /** USD of collateral seized/sold, INCLUDING any liquidation bonus/penalty. */
  seizedUsd: number
  /** USD recalled from deployment venues instead of collateral (Membrane only). */
  recalledUsd: number
  /** The penalty/bonus paid to the liquidator, in USD. */
  penaltyUsd: number
  why: string
}

export interface SimRun {
  engine: LiquidationEngineId
  label: string
  events: SimEvent[]
  /** Value of collateral still held at the end, priced at the final minute. */
  endCollateralUsd: number
  /** Debt still outstanding at the end. */
  endDebtUsd: number
  /**
   * Capital still sitting in deployment venues at the end.
   *
   * This MUST be carried, because equity is `collateral + deployed − debt`. Recalling
   * from a venue to repay debt moves a dollar off the asset side and a dollar off the
   * liability side — it is equity-neutral at the moment it happens. Leaving `deployed`
   * out of the balance sheet made every recall look like free money and materially
   * overstated Membrane. Membrane's real advantage is the liquidation penalty and the
   * forced sale it AVOIDS, not the recall itself.
   */
  endDeployedUsd: number
  /** Equity (collateral − debt) at the start and end, both priced at their own minute. */
  startEquityUsd: number
  endEquityUsd: number
  /** Total collateral value destroyed by liquidation penalties. This is the number
   *  that actually differs between engines — price moves hit both equally. */
  penaltyPaidUsd: number
  /** Peak LTV reached over the path. */
  peakLtv: number
  /** True if the position was fully wiped (no collateral left). */
  wiped: boolean
  /** Per-minute equity for charting. */
  equitySeries: (number | null)[]
  /** Per-minute LTV for charting. */
  ltvSeries: (number | null)[]
  provenance: Provenance
  /** Anything the run could not model faithfully. Rendered, never swallowed. */
  caveats: string[]
}

export interface Comparison {
  position: ProtocolPosition
  source: SimRun
  membrane: SimRun
  /** membrane.endEquityUsd − source.endEquityUsd. Positive = Membrane did better. */
  equityDeltaUsd: number
  /** Assets in the position that the price path could not cover, held flat. */
  unpricedSymbols: string[]
  scenarioLabel: string
}
