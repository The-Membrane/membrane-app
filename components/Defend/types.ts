// Shared types for the Defend feature (ported from public/proto/defend.html).

/** The whole risk vector a curator program outputs — the decision-surface levers. */
export interface DecisionParams {
  /** Liquidation LTV (M), 0..1. */
  M: number
  /** Borrow gap (g), 0..1. B = M − g. */
  g: number
  /** Collateral cap, in $M. */
  cap: number
  /** Delay window, in hours. */
  delay: number
  /** Oracle staleness tolerance, in minutes. */
  stale: number
}

/** A pinned house/venue baseline LTV shown as a tick on the decision surface. */
export interface Baseline {
  nm: string
  m: number
}

/** One leaderboard entry (a curator policy scored over 1,000 sims). */
export interface LeaderboardRow {
  rk: number
  who: string
  nm: string
  edge: number
  /** Submission attempts, or null for pinned house policies. */
  att: number | null
  house?: boolean
  you?: boolean
  /** Edge by hidden regime: [calm, vol, depth, cascade]. */
  regs: number[]
}

/** One row of the per-regime bleed breakdown for the last submission. */
export interface RegimeBleedRow {
  nm: string
  v: number
  why: string
}

/** Sandbox regime parameters. */
export interface RegimeSpec {
  vol: number
  jump: number
}

export type RegimeKey = 'calm' | 'stress' | 'cascade'

/** One step of a simulated price path with its event marker. */
export interface SimStep {
  p: number
  ev: '' | 'liq' | 'timer'
}

/** Result of the Membrane (delayed, partial-to-B) sim. */
export interface MembraneResult {
  out: SimStep[]
  liqs: number
  equity: number
  end: number
}

/** Result of the instant-liquidation venue sim. */
export interface InstantResult {
  out: SimStep[]
  liqs: number
  equity: number
}

/** Both venue outcomes over a single shared price path. */
export interface DuelResult {
  B: number
  membrane: MembraneResult
  instant: InstantResult
}

/** A label/value pair shown in the exec confirmation sheet. */
export interface ExecRow {
  label: string
  value: string
}

/** Config for the one confirmation an irreversible action gets. */
export interface ExecConfig {
  title: string
  rows: ExecRow[]
  note?: string
  cta?: string
  done?: string
}

/** Derived, display-ready outputs of the decision surface. */
export interface DecisionReadout {
  M: number
  g: number
  B: number
  wipe: number
  trig: number
  mVal: string
  gVal: string
  capVal: string
  bVal: string
  wipeVal: string
  headVal: string
  headClass: StatusClass
  effVal: string
  dSafeVal: string
  dYourVal: string
  dYourClass: StatusClass
  capHouse: string
  capBar: CapBarSegments
  capFlag: string
  capFlagClass: StatusClass
  oraErr: string
  oraFrz: string
  oraFrzClass: StatusClass
}

export type StatusClass = 'bad' | 'warn' | 'ok'

/** Cap-bar segment widths as percentages of the 0..$100M scale. */
export interface CapBarSegments {
  greenPct: number
  over: boolean
  redLeftPct: number
  redWidthPct: number
  tickPct: number
}
