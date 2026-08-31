// Types for the Carry Builder (ported from public/proto/builder.html).

export type VenueClass = 'stable' | 'lst' | 'synth'
export type Intent = 'repay' | 'compound' | 'distribute'

/** A deployable venue tile. `liq` = share recallable at liquidation, `spd` = share
 *  that can arrive inside a cure window (speed, not depth). */
export interface Tile {
  id: string
  nm: string
  cls: VenueClass
  apr: number
  liq: number
  spd: number
  note: string
}

/** A starter board. Each template is deliberately missing one thing that would
 *  have saved it. */
export interface Template {
  nm: string
  slots: string[]
  ltv: number
  doc: string
}

/** How a floor reaches the position. Optional channels default to inactive. */
export interface Scenario {
  n: string
  era: string
  days: number
  coll: number
  hair: Partial<Record<VenueClass, number>>
  freeze: VenueClass[]
  fail: number
  mech: string
  rate?: number
  ltvCut?: number
  stale?: number
  timer?: number
  bleed?: Partial<Record<VenueClass, number>>
  closed?: number
  divest?: number
}

/** Board-editing state. */
export interface St {
  btc: number
  ltv: number
  slots: (string | null)[]
  intent: Intent
  tested: boolean
}

/** Derived throughput/health for a board. */
export interface Calc {
  coll: number
  debt: number
  p: Tile[]
  apr: number
  liq: number
  earn: number
  cost: number
  net: number
  ltv: number
}

export type RunPhase = 'idle' | 'forecast' | 'accrue' | 'shock' | 'shocked' | 'wait'
export type FloorMark = 'clean' | 'hurt' | 'dead' | undefined

export interface RunSnap {
  floor: number
  btc: number
  banked: number
  lost: number
  debtX: number
  ltvCut: number
  pushed: boolean
  banned: Record<string, number>
  sick: Record<string, number>
}

/** Live sweep state through the fifteen floors. */
export interface RunState {
  active: boolean
  floor: number
  btc: number
  banked: number
  lost: number
  dead: boolean
  phase: RunPhase
  t: number
  target: number
  shown: number
  ltvCut: number
  debtX: number
  banned: Record<string, number>
  sick: Record<string, number>
  closed: boolean
  marks: FloorMark[]
  snap?: RunSnap
}

export interface Forecast {
  p: number
  o: 0 | 1
  floor: number
  nm: string
}

export interface SeedInfo {
  id: string
  isDaily: boolean
  dateStr: string
}

/** One resolved venue row inside a floor receipt. */
export interface AuditRow {
  t: Tile
  share: number
  hair: number
  bleed: number
  value: number
  frozen: boolean
  ban: boolean
  divest: boolean
  liq: number
  ret: number
  failed: boolean
  shown: number
  why: string
}

export interface AuditResult {
  rows: AuditRow[]
  stale: number
  fast: number
  shown: number
  recalled: number
  haircut: number
  bleed: number
  debt: number
}

/** One floor resolved against one board+run state, with no side effects. */
export interface Resolution {
  c: Calc
  a: AuditResult
  px: number
  ltvAfter: number
  line: number
  breached: boolean
  needed: number
  recalled: number
  shortfall: number
  cured: boolean
  frozenOut: boolean
  sold: number
  btcAfter: number
  wiped: boolean
  debtXAfter: number
  ltvCutAfter: number
  survived: boolean
  bind: { k: string; why: string }
}

/** Immutable board+run context handed to resolveCore/simReference. */
export interface CoreState {
  slots: (string | null)[]
  ltv: number
  btc: number
  debtX: number
  ltvCut: number
  banned: Record<string, number>
  sick: Record<string, number>
}

export interface RunResult {
  who: string
  floors: number
  deadFloors?: number[]
  marks?: FloorMark[]
  btc: number
  banked: number
  lost: number
  net: number
  mine?: boolean
  seed?: string
  unranked?: boolean
  build: string
}

export interface GhostRow {
  label: string
  R: Resolution
  you?: boolean
}

export interface SeedBookEntry {
  id: string
  first: string
  runs: number
  best: number
  bestNet: number | null
  label?: string
  daily?: string
  last?: string
}
