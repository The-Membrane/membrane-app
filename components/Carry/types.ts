// Shared types for the Carry feature. Ported from the mock data shapes in
// public/proto/carry.html (the design prototype of record).

/** A yield-bearing collateral option in the picker + ladder. */
export interface Collateral {
  sym: string
  /** Today's yield %, marked as such (moves in production). */
  yld: number
  /** 1-in-1000 8-hour drawdown, %. Measured only when `measured` is set. */
  p999: number
  /** Worst observed 8h drawdown, %. */
  worst: number
  /** Max LTV (draw) the asset is granted. */
  maxLtv: number
  /** Number of 8-hour windows behind p999/worst. */
  n: number
  /**
   * Provenance of the drawdown tail. Present => p999/worst/n were computed from
   * real hourly OHLCV and the range is quotable. Absent => the numbers are
   * inherited from a source dataset that is not on disk and cannot be verified;
   * the UI must not claim they are measured.
   */
  measured?: {
    /** Inclusive UTC date range actually covered, e.g. '2023-10-30 to 2026-05-04'. */
    range: string
    /** Short source label for the stamp. */
    source: string
  }
}

/** A one-decision risk preset. Presets commit a full, named vector. */
export interface Preset {
  id: string
  nm: string
  lev: number
  coll: string
  yld: number
  venues: string
  /** % of your room the 1-in-1000 move uses (headline figure). */
  room: number
  /** Human descriptor shown under the preset name. */
  pd: string
}

/** A leaderboard row from the gauntlet + position history (mock). */
export interface Board {
  rk: number
  nm: string
  coll: string
  lev: number
  yld: number
  venues: string
  room: number
  surv: string
  cov: string
  /** The board died — carry shows negative and styles as blood. */
  dead?: boolean
}

/** A measured cross-protocol carry route (A+B evidence, Aug 2026). */
export interface Route {
  proto: string
  src: string
  /** DefiLlama link for the source token/product. */
  su: string
  dst: string
  /** DefiLlama link for the destination token/product. */
  du: string
  pos: number
  /** Net spread %, per dollar. Negative routes are the losing ones — kept. */
  net: number
  /** Wider bar opacity for the largest route. */
  big?: boolean
  /** Inline caveat rendered in blood next to the route name. */
  note?: string
}

/** One coloured segment of a rich note string. */
export interface NoteSegment {
  t: string
  tone?: 'gold'
}

/** Per-venue redemption / recall history: liquidation-time liquidity evidence. */
export interface RedemptionVenue {
  v: string
  sub: string
  /** Requested (redeemed) over 90d, USD. */
  req: number
  /** Served over 90d, USD. */
  srv: number
  /** Slash events. */
  slash: number
  slashAmt: number
  /** Liquidation recalls. */
  rec: number
  recOk: number
  ban: boolean
  /** Whether this venue shows an oracle chip (PT). */
  oracle?: string
  /** Footnote, as coloured segments. */
  noteSegments: NoteSegment[]
}

/** A single row in the execution confirm sheet. */
export interface ExecRow {
  label: string
  value: string
}

/** The full config for one confirmation choreography. */
export interface ExecConfig {
  title: string
  rows: ExecRow[]
  note?: string
  cta?: string
  done?: string
}

export type OraclePtMode = 'calm' | 'spike' | 'depeg'

/** An oracle-info card definition. */
export interface OracleInfo {
  /** [severity class, label] — severity is 'med' or 'plan'. */
  tag: ['med' | 'plan', string]
  /** Summary paragraph (may contain rich <b class> markup). */
  sum: string
  /** "In simple terms" bullets (rich markup). */
  li: string[]
  /** Optional wiring/model note (gold box). */
  wire?: string
  /** PT card renders the discount-curve canvas. */
  pt?: boolean
}
