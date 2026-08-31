// Shared types for the Position feature (ported from public/proto/dash.html).
// The proto is the design spec; its inline mock data becomes the typed fixtures
// in fixtures.ts, and these interfaces describe their shape.

/** Venue asset class → drives the swatch colour on belt packets and feed rows. */
export type VenueClass = 'synth' | 'stable' | 'lst'

/** The three account roles the page can render. The page IS the account. */
export type Role = 'borrow' | 'lend' | 'curate'

/** A settled belt delivery (realized yield packet). */
export interface Delivery {
  amt: number
  /** Venue name, e.g. 'sUSDe'. */
  venue: string
  cls: VenueClass
  /** Human effect line, e.g. '0.35 days of debt burned'. */
  eff: string
  ago: string
}

/** A deployment venue, measured. Renders as a row in the belt list drawer. */
export interface Venue {
  nm: string
  cls: VenueClass
  /** Dollars deployed at the venue. */
  dep: number
  /** Share of the stack, e.g. '33.4%'. */
  share: string
  /** 14-day average deliveries, e.g. '$4.11 / day'. */
  del14: string
  /** Fraction of the venue's inventory that could be recalled, e.g. '30%'. */
  recall: string
  state: string
  home: string
  addr: string
  measured: string
}

/** Cumulative-delivery chart series, keyed by range. */
export type ChartRange = 'life' | '90d' | '30d'
export type BenchMode = 'hold' | 'sold' | null

/** A per-intent countdown card (Repay / Compound / Distribute). */
export interface Intent {
  id: number
  name: string
  tag: string
  active: boolean
  /** The big lead number line (already formatted). */
  lead: string
  /** Small unit suffix beside the lead. */
  leadUnit?: string
  /** Colour band on the lead: 'days' = ink, 'v' = teal, 'vgold' = gold. */
  leadBand: 'days' | 'v' | 'vgold'
  /** Veteran-mode badge shown in place of the warm description, e.g. 'venue rates'. */
  badge: string
  /** Warm teaching copy (hidden in veteran view). */
  desc: string
  /** Optional "use it wisely" warning tooltip. */
  wico?: { title: string; body: string }
  bar: HpBar | RngBar
  notes: [string, string]
  mini: MiniRow[]
}

/** A hazard-progress bar (Repay): a fill with a single mark. */
export interface HpBar {
  type: 'hp'
  fill: number
  mark: number
}

/** A projection range bar (Compound / Distribute): band with visible edges. */
export interface RngBar {
  type: 'rng'
  gold?: boolean
  bandLeft: number
  bandWidth: number
  edges: number[]
  /** Realized point (single tick), Compound only. */
  pt?: number
  /** Goal marker, Distribute only. */
  goal?: number
}

export interface MiniRow {
  label: string
  value: string
  /** Colour token key for the value: phosphor/gold/blood, else default. */
  color?: 'phos' | 'gold' | 'blood'
  /** Distribute's "Withdrawable now" row carries an inline Claim exec button. */
  claim?: ExecPayload
}

/** A named, retroactively-scored market encounter. */
export interface Encounter {
  when: string
  bad: boolean
  title: string
  /** Body copy with inline emphasis markers; rendered via renderEmphasis(). */
  body: string
  stamp: string
}

/** A calibration confidence band. */
export interface Band {
  k: string
  ideal: number
  hit: number
  n: number
}

/** A points/sacrifice class row. */
export interface PointsClass {
  c: string
  sub: string
  fee: number
  /** Live sacrifice ratio r (percent). */
  r: number
  /** Ratio the Transmuter last cached; a gap shows a gold "pending" line. */
  synced: number
  pend: number
  closed: number
  active: boolean
}

/** A realized fee/earnings feed row (lend + curate roles). */
export interface FeedRow {
  amt: number
  src: string
  ago: string
}

/** A lender seat (tranche). */
export interface Seat {
  name: string
  staked: string
  /** Loss-order segments: [width%, tokenAlpha] with the "me" segment flagged. */
  lossOrder: LossSegment[]
  mini: MiniRow[]
}

export interface LossSegment {
  width: number
  /** 'teal' | 'gold' | 'phos' | 'blood' → alpha fill of that token. */
  tone: 'teal' | 'gold' | 'phos' | 'blood'
  me?: boolean
}

/** A curator vault allocation slice. */
export interface CompSlice {
  label: string
  pct: number
  /** 'bone' | 'gold' | 'teal' → base swatch colour. */
  tone: 'bone' | 'gold' | 'teal'
}

/** A lifestyle-equivalence item (the measured rate, priced in things). */
export interface LifeItem {
  nm: string
  mo: number
  approx?: boolean
}

/** A demo tour step: [selector-ish key, title, body]. */
export interface TourStep {
  key: string
  title: string
  body: string
}

/** Payload for the one confirm sheet an irreversible action gets. */
export interface ExecPayload {
  title: string
  rows: [string, string][]
  note?: string
  cta?: string
  done?: string
}
