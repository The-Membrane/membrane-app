/** Venue keys for the hero "put it to work in" segment. */
export type VenueKey = 'steady' | 'bal' | 'hot'

/** A deployment venue mix — porting `VENUES` from public/proto/landing.html. */
export interface Venue {
  /** Display name shown in the segment + copy. */
  nm: string
  /** Human mix label used in the recall footnote. */
  mix: string
  /** Venue APR (yield) as a fraction, e.g. 0.079 = 7.9%. */
  apr: number
  /** Share of the deployed loan recallable under normal conditions (0..1). */
  liquid: number
  /** Share recallable with a cooldown-bearing venue locked (0..1). */
  cooled: number
  /** One-line description used in the CTA constraint copy. */
  note: string
}

/** Hero calculator inputs. */
export interface LandingState {
  /** Bitcoin held. */
  btc: number
  /** Loan-to-value as a fraction (0..1). */
  ltv: number
  /** Selected venue. */
  venue: VenueKey
}

/** Derived numbers from {@link calc}. */
export interface LandingCalc {
  coll: number
  debt: number
  v: Venue
  earn: number
  cost: number
  net: number
  /** Price at which the grace clock starts (LTV crosses max). */
  trigger: number
  /** Drop % from today's price to the trigger. */
  dropPct: number
}

/** Carry-box emphasis variant, mirroring the proto's `.carry` / `.warn` / `.neg`. */
export type CarryVariant = 'default' | 'warn' | 'neg'

/** A single measured carry route row. */
export interface Route {
  nm: string
  pos: number
  net: number
  big?: boolean
}

/** A recall trajectory cell in the "venue recall" panel. */
export interface RecallRow {
  w: string
  d: number
  n: string
  now?: boolean
  warn?: boolean
}

/** A risk-desk tier row. */
export interface Tier {
  nm: string
  st: string
  always?: boolean
}

/** A summary stat card (routes-positive/negative/etc). */
export interface StatCard {
  k: string
  v: string
  n: string
  /** Semantic color key for the value, if emphasized. */
  tone?: 'success' | 'danger'
}
