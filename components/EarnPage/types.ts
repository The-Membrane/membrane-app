// Types ported from the mock data structures embedded in public/proto/supply.html.

/** Sect 01 — pool composition group, drives the shared color per asset. */
export type CompositionGroup = 'yield-$' | 'BTC' | 'ref'

export interface PoolAsset {
  sym: string
  grp: CompositionGroup
  /** Percent share of pool collateral, 0-100. */
  share: number
}

/** Sect 02 — one of the three withdrawal-capacity bands. Never fold STRANDED into the others. */
export type CapacityBandKey = 'instant' | 'cooling' | 'stranded'

export interface CapacityBand {
  key: CapacityBandKey
  label: string
  /** USD amount backing this band. */
  amountUsd: number
}

/** A styled text run inside a venue note — lets "$1.57M stranded" render in blood/gold without HTML. */
export interface NoteSegment {
  text: string
  tone?: 'success' | 'warning' | 'danger'
  bold?: boolean
}

export interface VenueLiquidity {
  venue: string
  sub: string
  instantUsd: number
  coolingUsd: number
  strandedUsd: number
  note: NoteSegment[]
}

/** Sect 03 — per-collateral loss-order waterfall the seat is drawn on. */
export interface WaterfallSeat {
  sym: string
  seat: 'senior' | 'junior'
  discoUsd: string
  discoWidth: number
  juniorUsd: string
  juniorWidth: number
  seniorUsd: string
  seniorWidth: number
  /** Explains the seat's position in the loss order, rendered under the diagram. */
  caption: string
}

/** Sect 04 — a single realized/settled revenue distribution. */
export interface RevenueEntry {
  amountUsd: number
  source: string
  ago: string
}

/** Sect 05 — a candidate collateral available to list via a junior-tranche stake. */
export interface ShopOption {
  sym: string
  /** Worst 0.1% rolling 8h price move, measured, as a positive percent (rendered with a minus sign). */
  p999: number
  mcap: string
  /** Projected revenue band, e.g. "4–9%". */
  band: string
  /** Number of measured 8h windows behind p999. */
  windowCount: number
  /** Circulating-supply × price source line. */
  src: string
}

export interface SeatOption {
  value: string
  label: string
}

/** One line in the execution-sheet confirmation table. */
export interface ExecRow {
  label: string
  value: string
}

/** A pending confirm-and-sign request, ported from the proto's `window.__exec(o)`. */
export interface ExecRequest {
  title: string
  rows: ExecRow[]
  note?: string
  cta?: string
  done?: string
}

export type ExecPhase = 'idle' | 'signing' | 'pending' | 'done'
