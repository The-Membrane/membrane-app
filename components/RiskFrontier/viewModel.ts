/**
 * Risk Frontier — view model. PURE: turns the sandbox inputs into a `StressPosition` and the
 * engine's results (lib/position-sim/frontier.ts, stressGrid.ts) into what the screen draws.
 * No React, no fetch. Tested in tests/unit/riskFrontierView.test.ts.
 *
 * Copy rules (docs/RISK_FRONTIER_DESIGN.md §6), enforced here so no component has to:
 *  - every result is a stress scenario, not a probability (STRESS_LABEL); no weights, odds,
 *    win rates or confidence figures anywhere;
 *  - distances are WHOLE units rounded toward risk (frontier.ts `display`) and are quoted as
 *    "past N%": nothing triggers at N, the edge sits in (N, N + 1];
 *  - the exposed slice is a dollar figure; no "safe"/"ok" wording; no 0%/free borrowing,
 *    no carry claim; no 8h window on the no-delay class.
 */

import type { ExitCapacityFloorId } from '@/lib/position-sim/exitCapacityAnalogs'
import {
  DEFAULT_VENUE_REFERENCE,
  REVERSE_SOLVE_DROPS,
  distanceToDanger,
  type DistanceToDanger,
  type FrontierEdge,
} from '@/lib/position-sim/frontier'
import {
  BORROW_LTV_GAP,
  LIQ_DEBT_MINIMUM_USD,
  MEMBRANE_CLASS_PARAMS,
  type MembraneClass,
} from '@/lib/position-sim/membrane'
import {
  DEFAULT_CAPACITY_MULTS,
  DEFAULT_FREEZE_HOURS,
  DEFAULT_PRICE_SHAPES,
  EXIT_CAPACITY_DEFAULT_PRESET,
  EXIT_CAPACITY_PRESETS,
  STRESS_CODE_VERSION,
  STRESS_LABEL,
  exitCapacityFloorOf,
  runStress,
  type ExitCapacityPresetId,
  type NotModelledReason,
  type PriceShape,
  type StressModelled,
  type StressPosition,
  type StressResult,
  type StressScenario,
  type TradeShape,
  type VenueStress,
} from '@/lib/position-sim/stressGrid'

export { STRESS_CODE_VERSION, STRESS_LABEL }

// ------------------------------------------------------------------ format

/** Whole-dollar USD with thousands separators; a real minus sign. */
export function usd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  const sign = n < 0 ? '−' : ''
  return `${sign}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`
}

/** USD, or "none" for nothing: no bare $0 on this page. */
export function usdOrNone(n: number | null | undefined): string {
  return n === null || n === undefined || !Number.isFinite(n)
    ? '—'
    : Math.round(n) === 0
      ? 'none'
      : usd(n)
}

/** Compact USD: $940, $14.2k, $1.05M. */
export function usdShort(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  const a = Math.abs(n)
  const sign = n < 0 ? '−' : ''
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`
  if (a >= 1e4) return `${sign}$${(a / 1e3).toFixed(1)}k`
  return `${sign}$${Math.round(a).toLocaleString('en-US')}`
}

/**
 * A ratio as a percentage. Infinity (collateral gone with debt owed) prints ∞; an exact
 * zero prints "—" so no figure on this page ever reads as a bare "0%".
 */
export function pct(x: number | null | undefined, dp = 1): string {
  if (x === null || x === undefined || Number.isNaN(x)) return '—'
  if (x === Infinity) return '∞'
  if (x === 0) return '—'
  return `${(x * 100).toFixed(dp)}%`
}

/** Seconds as a short duration: <1m, 45m, 8h, 21h 18m. Null prints "—". */
export function duration(s: number | null | undefined): string {
  if (s === null || s === undefined || !Number.isFinite(s)) return '—'
  if (s < 60) return '<1m'
  const totalM = Math.round(s / 60)
  const h = Math.floor(totalM / 60)
  const m = totalM % 60
  if (h === 0) return `${m}m`
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

// ----------------------------------------------------------------- inputs

export type CapacityChoice =
  | { kind: 'preset'; preset: ExitCapacityPresetId }
  /** Exit capacity = deployed × mult, passed to the engine as a multiple (`exitCapacityMult`). */
  | { kind: 'custom'; mult: number }

export interface SandboxInputs {
  collateralUsd: number
  debtUsd: number
  membraneClass: MembraneClass
  line: number
  tradeShape: TradeShape
  /** Carry only. Capped at the debt. */
  deployedUsd: number
  capacity: CapacityChoice
  debtMinimumUsd: number
}

/** An exit-capacity multiple as typed: up to 4 decimals, no trailing zeros (×0.1119, ×0.5). */
export function multText(m: number | null | undefined): string {
  return m === null || m === undefined || !Number.isFinite(m) ? '—' : String(Number(m.toFixed(4)))
}

/**
 * The opening loadout: the design's illustrative carry position (§3). The capacity
 * default is the measured typical Aave USDC stress event against a $50M Membrane book (cash
 * vs book, owner ruling 2026-10-07; instruction 2026-10-06: "typical Aave capacity during
 * stress over the last 3 years") — never the 'optimistic' bound (owner ruling 2026-10-04:
 * full withdrawability is the most optimistic case, an upper bound only). That measured level
 * can itself resolve to ×1 — the venue's idle cash covered the whole book — and its label then
 * says so; no quick start resolves to an unlabelled ×1 (tests/unit/riskFrontierView.test.ts).
 */
export const DEFAULT_INPUTS: SandboxInputs = {
  collateralUsd: 44_000,
  debtUsd: 31_400,
  membraneClass: 'delayed',
  line: 0.86,
  tradeShape: 'carry',
  deployedUsd: 14_200,
  capacity: { kind: 'preset', preset: EXIT_CAPACITY_DEFAULT_PRESET },
  debtMinimumUsd: LIQ_DEBT_MINIMUM_USD,
}

export interface Loadout {
  id: string
  name: string
  sub: string
  inputs: SandboxInputs
}

/** Quick-start positions for testing. Illustrative sandbox values, not real wallets. */
export const LOADOUTS: readonly Loadout[] = [
  { id: 'carry', name: 'Carry', sub: 'LTV 71% · line 86%', inputs: DEFAULT_INPUTS },
  {
    id: 'tight-carry',
    name: 'Tight carry',
    sub: 'LTV 80% · Aave USDC, Kelp lock',
    inputs: {
      ...DEFAULT_INPUTS,
      collateralUsd: 40_000,
      debtUsd: 32_000,
      deployedUsd: 30_000,
      capacity: { kind: 'preset', preset: 'aave-usdc-50m-worst' },
    },
  },
  {
    id: 'levered',
    name: 'Levered long',
    sub: 'LTV 65% · no recall',
    inputs: {
      ...DEFAULT_INPUTS,
      collateralUsd: 50_000,
      debtUsd: 32_500,
      tradeShape: 'levered_long',
      deployedUsd: 0,
    },
  },
  {
    id: 'no-delay',
    name: 'No-delay stable',
    sub: 'line 95% · no window',
    inputs: {
      ...DEFAULT_INPUTS,
      collateralUsd: 100_000,
      debtUsd: 88_000,
      membraneClass: 'no-delay',
      line: 0.95,
      deployedUsd: 60_000,
      capacity: { kind: 'preset', preset: EXIT_CAPACITY_DEFAULT_PRESET },
    },
  },
  {
    id: 'small',
    name: 'Small loan',
    sub: '$3k debt · near the floor',
    inputs: {
      ...DEFAULT_INPUTS,
      collateralUsd: 4_000,
      debtUsd: 3_000,
      deployedUsd: 2_500,
      capacity: { kind: 'preset', preset: EXIT_CAPACITY_DEFAULT_PRESET },
    },
  },
]

export interface ClassView {
  cls: MembraneClass
  ceiling: number
  band: number
  windowHours: number
  ceilingText: string
  bandText: string
  windowText: string
}

export function classView(cls: MembraneClass): ClassView {
  const p = MEMBRANE_CLASS_PARAMS[cls]
  const windowHours = p.windowSeconds / 3600
  return {
    cls,
    ceiling: p.ltvCeiling,
    band: p.band,
    windowHours,
    ceilingText: `line ≤ ${pct(p.ltvCeiling, 0)}`,
    bandText: p.band > 0 ? `${pct(p.band, 0)} band` : 'no band',
    windowText: windowHours > 0 ? `${windowHours}h window` : 'no window · sale at the line',
  }
}

/** Lowest line the sandbox accepts. */
export const MIN_LINE = 0.05

/** Clamp a line into [MIN_LINE, class ceiling]. */
export function clampLine(line: number, cls: MembraneClass): number {
  const ceiling = MEMBRANE_CLASS_PARAMS[cls].ltvCeiling
  if (!Number.isFinite(line)) return ceiling
  return Math.min(ceiling, Math.max(MIN_LINE, line))
}

export interface SandboxPosition {
  position: StressPosition
  /** The line actually used (clamped to the class ceiling). */
  line: number
  lineClamped: boolean
  /** Deployed after the cap at the debt (0 for levered long). */
  deployedUsd: number
  deployedClamped: boolean
  startLtv: number
  /** Where a recall aims: line − 3pp (membraneRecallTarget lands here). */
  recallTarget: number
  breakLine: number
  /** Exit-capacity multiplier on the deployed amount. Null for levered long. */
  capacityMult: number | null
  /** The chosen level's name ('Aave USDC · $50M book · typical · ×1, cash covers the book',
   *  'custom'). A ×1 always says so. Null for levered long. */
  capacityLabel: string | null
  /** The preset's measured lock: no recall for this long from the first breach, hours. */
  capacityLockHours: number | null
  /** Resolved exit capacity, USD. Null for levered long. */
  exitCapacityUsd: number | null
  overLine: boolean
}

/** Sandbox inputs → the engine's StressPosition, with every clamp reported. */
export function buildStressPosition(inp: SandboxInputs): SandboxPosition {
  const params = MEMBRANE_CLASS_PARAMS[inp.membraneClass]
  const line = clampLine(inp.line, inp.membraneClass)
  const carry = inp.tradeShape === 'carry'
  const debt = Number.isFinite(inp.debtUsd) ? Math.max(0, inp.debtUsd) : NaN
  const rawDeployed = Number.isFinite(inp.deployedUsd) ? Math.max(0, inp.deployedUsd) : 0
  const deployed = carry ? Math.min(rawDeployed, Number.isFinite(debt) ? debt : 0) : 0
  const mult = !carry
    ? null
    : inp.capacity.kind === 'preset'
      ? EXIT_CAPACITY_PRESETS[inp.capacity.preset].mult
      : Math.min(1, Math.max(0, Number.isFinite(inp.capacity.mult) ? inp.capacity.mult : 0))
  const position: StressPosition = {
    collateralUsd: inp.collateralUsd,
    debtUsd: debt,
    line,
    membraneClass: inp.membraneClass,
    tradeShape: inp.tradeShape,
    debtMinimumUsd: Math.max(0, Number.isFinite(inp.debtMinimumUsd) ? inp.debtMinimumUsd : 0),
  }
  if (carry) {
    position.deployedUsd = deployed
    // A custom choice is a MULTIPLE of the deployed amount, like a preset — not a fixed $
    // figure, which the reverse solve would hold while it rescales the debt and deployed
    // amount (custom ×0.50 then disagreed with the ×0.5 preset of the time).
    if (inp.capacity.kind === 'preset') position.exitCapacityPreset = inp.capacity.preset
    else position.exitCapacityMult = mult as number
  }
  const startLtv = inp.collateralUsd > 0 ? debt / inp.collateralUsd : NaN
  return {
    position,
    line,
    lineClamped: Math.abs(line - inp.line) > 1e-12,
    deployedUsd: deployed,
    deployedClamped: carry && deployed < rawDeployed,
    startLtv,
    recallTarget: Math.max(0, line - BORROW_LTV_GAP),
    breakLine: line * (1 + params.band),
    capacityMult: mult,
    capacityLabel: !carry
      ? null
      : inp.capacity.kind === 'preset'
        ? EXIT_CAPACITY_PRESETS[inp.capacity.preset].label
        : 'custom',
    capacityLockHours: !carry
      ? null
      : inp.capacity.kind === 'preset'
        ? EXIT_CAPACITY_PRESETS[inp.capacity.preset].freezeHours
        : 0,
    exitCapacityUsd: mult === null ? null : deployed * mult,
    overLine: startLtv >= line,
  }
}

// ---------------------------------------------------------------- outcomes

/** Glyph per outcome. Colour is never the only carrier: every glyph has its own shape. */
export type Glyph = '●' | '◆' | '▲' | '■' | '✖' | '░'
export type Tone = 'clear' | 'recall' | 'armed' | 'call' | 'sold' | 'muted'

export interface LeafView {
  glyph: Glyph
  tone: Tone
  /** Two or three words. */
  title: string
  /** One short line, numbers first. */
  short: string
}

const NOT_MODELLED_TEXT: Record<NotModelledReason, string> = {
  invalid_position: 'position invalid',
  no_exit_capacity: 'exit capacity not chosen',
  line_out_of_class_range: 'line outside the class range',
  invalid_shape: 'scenario shape invalid',
  invalid_venue: 'venue condition invalid',
  no_recall_levered_long: 'levered long: no venue recall',
  mixed_class: 'mixed collateral classes',
  no_line: 'no line',
}

export function notModelledText(reason: NotModelledReason): string {
  return NOT_MODELLED_TEXT[reason] ?? 'not modelled'
}

/** The legend, in severity order. */
export const LEGEND: readonly { glyph: Glyph; tone: Tone; text: string }[] = [
  { glyph: '●', tone: 'clear', text: 'no breach' },
  { glyph: '◆', tone: 'recall', text: 'line crossed, recall restored it' },
  { glyph: '▲', tone: 'armed', text: 'window armed, then cured' },
  { glyph: '■', tone: 'call', text: 'sale call, recall covered it (left over the line)' },
  { glyph: '✖', tone: 'sold', text: 'collateral sold ($ shown)' },
  { glyph: '░', tone: 'muted', text: 'not modelled (reason shown)' },
]

/** One result → glyph, tone and its short line. `missing` explains a leaf with no result. */
export function leafView(r: StressResult | null, missing?: string): LeafView {
  if (!r) return { glyph: '░', tone: 'muted', title: 'Not modelled', short: missing ?? 'no result' }
  switch (r.outcome) {
    case 'not_modelled':
      return { glyph: '░', tone: 'muted', title: 'Not modelled', short: notModelledText(r.reason) }
    case 'no_breach':
      return { glyph: '●', tone: 'clear', title: 'No breach', short: `peak LTV ${pct(r.peakLtv)}` }
    case 'recall_cured':
      return {
        glyph: '◆',
        tone: 'recall',
        title: 'Recall restored',
        short: `recalled ${usdShort(r.recallDrawnUsd)}`,
      }
    case 'armed_cured':
      return {
        glyph: '▲',
        tone: 'armed',
        title: 'Armed, cured',
        short: `armed at ${duration(r.timeToArmSeconds)}`,
      }
    case 'recall_liquidated':
      return {
        glyph: '■',
        tone: 'call',
        title: 'Sale call, covered',
        short: `recalled ${usdShort(r.recallDrawnUsd)} · nothing sold`,
      }
    case 'sold':
      return {
        glyph: '✖',
        tone: 'sold',
        title: 'Sold',
        short: `${usdShort(r.exposedUsd)} of collateral`,
      }
  }
}

/**
 * The swatch cell's one compact line (the grid is too narrow for title + short): the glyph
 * carries the outcome, this carries the number. Full words go in the cell's label.
 */
export function swatchText(r: StressResult): string {
  switch (r.outcome) {
    case 'not_modelled':
      return 'not modelled'
    case 'no_breach':
      return `peak ${pct(r.peakLtv, 0)}`
    case 'recall_cured':
      return `recall ${usdShort(r.recallDrawnUsd)}`
    case 'armed_cured':
      return `armed ${duration(r.timeToArmSeconds)}`
    case 'recall_liquidated':
      return `call · ${usdShort(r.recallDrawnUsd)}`
    case 'sold':
      return `${usdShort(r.exposedUsd)} sold`
  }
}

/** Long outcome name for the detail panel. */
export function outcomeTitle(r: StressResult): string {
  switch (r.outcome) {
    case 'not_modelled':
      return `Not modelled: ${notModelledText(r.reason)}`
    case 'no_breach':
      return 'No breach: the line was never crossed'
    case 'recall_cured':
      return 'Line crossed: venue recall alone restored it, no timer armed'
    case 'armed_cured':
      return 'Window armed, then cleared with nothing sold'
    case 'recall_liquidated':
      return 'Sale call covered by recall: nothing sold, left over the line'
    case 'sold':
      return `Collateral sold: ${usd(r.exposedUsd)}`
  }
}

// ------------------------------------------------------------------ edges

export type EdgeState = 'found' | 'already' | 'beyond' | 'na'

export interface EdgeView {
  state: EdgeState
  /** Position on the ruler in native units (fraction or hours), rounded toward risk. Null off-scale. */
  at: number | null
  /** The figure: "35%", "<1%", "now", ">99%", "no window". */
  text: string
  /** One line: what the figure means. */
  hint: string
  /** The keyed node just past the edge (frontier.ts `at`). */
  node: StressModelled | null
}

const NA_TEXT: Record<'no_delay_class' | 'levered_long_no_recall' | 'not_modelled', string> = {
  no_delay_class: 'no window',
  levered_long_no_recall: 'no recall',
  not_modelled: 'not modelled',
}

function unitText(display: number, unit: 'pct' | 'hours'): string {
  if (unit === 'hours') return display === 0 ? '<1h' : `${display}h`
  return display === 0 ? '<1%' : `${display}%`
}

const modelled = (r: StressResult | undefined): StressModelled | null =>
  r && r.outcome !== 'not_modelled' ? r : null

/** A frontier edge → its ruler view. `what` names the axis unit in the hint ("drop", "cut", "freeze"). */
export function edgeView(edge: FrontierEdge, what: string): EdgeView {
  switch (edge.status) {
    case 'found': {
      const text = unitText(edge.display, edge.unit)
      const next = unitText(edge.display + 1, edge.unit).replace('<', '')
      const scale = edge.unit === 'pct' ? 100 : 1
      return {
        state: 'found',
        at: edge.display / scale,
        text,
        hint:
          edge.display === 0
            ? `the edge is under ${next} of ${what}`
            : `nothing at ${text} of ${what}; the edge is in (${text}, ${next}]`,
        node: modelled(edge.at),
      }
    }
    case 'already':
      return {
        state: 'already',
        at: 0,
        text: 'now',
        hint: `triggers with no ${what}`,
        node: modelled(edge.at),
      }
    case 'beyond_range': {
      const text = edge.unit === 'pct' ? `>${Math.round(edge.max * 100)}%` : `>${edge.max}h`
      return {
        state: 'beyond',
        at: null,
        text,
        hint: `nothing up to ${text.slice(1)} of ${what}`,
        node: null,
      }
    }
    case 'not_applicable':
      return {
        state: 'na',
        at: null,
        text: NA_TEXT[edge.reason],
        hint: NA_TEXT[edge.reason],
        node: null,
      }
  }
}

// ------------------------------------------------------------------ tree

export type LaneId = 'flat' | 'step10' | 'step25' | 'wick25' | 'oct10' | 'freeze8' | 'capFloor'

export interface LaneDef {
  id: LaneId
  label: string
  sub: string
  parent: LaneId | null
  scenario: StressScenario | null
  /** Why a lane has no scenario (the Oct 10 tape not loaded yet). */
  missing: string | null
}

/** The venue sub-branches hang off the named reference shock (frontier.ts DEFAULT_VENUE_REFERENCE). */
export const TREE_FREEZE_HOURS = 8

/**
 * The tree's capacity lane: EVERYONE EXITS at the position's OWN venue — the pro-rata floor of
 * the chosen measured level (same venue, same level: stressGrid `exitCapacityFloorOf`), run as
 * an ABSOLUTE venue condition (`venue.exitCapacityPreset`): it replaces the chosen capacity and
 * lock, it does not scale them. Review 2026-10-07: the lane used to multiply the default
 * venue's floor ÷ default cut (×0.1119) onto whatever capacity the position chose, so it was
 * the everyone-exits floor only at the default preset (under Aave USDC $50M worst it ran
 * ×0.0000112 and still said "everyone exits"). A bound or a custom multiple names no venue:
 * null, and the lane is missing with the reason — never an arbitrary or silent multiplier.
 */
export function treeFloorPreset(capacity: CapacityChoice): ExitCapacityFloorId | null {
  return capacity.kind === 'preset' ? exitCapacityFloorOf(capacity.preset) : null
}

/** Why the everyone-exits lane has no scenario: the capacity names no measured venue. */
export const TREE_FLOOR_MISSING = 'no venue chosen: everyone exits needs a measured venue'

/**
 * The tree's branches, in order. Equal-width, no weights. Venue rows sit under the −25% step
 * because a venue condition only matters once recall is needed; they diverge at the first
 * breach (a freeze is counted from it).
 */
export function treeLanes(
  capacity: CapacityChoice,
  replay: PriceShape | null,
  replayMissing = 'Oct 10 tape loading',
): LaneDef[] {
  const ref = DEFAULT_VENUE_REFERENCE
  const floorId = treeFloorPreset(capacity)
  const floor = floorId ? EXIT_CAPACITY_PRESETS[floorId] : null
  const floorLock = floor && floor.freezeHours > 0 ? ` · ${floor.freezeHours}h lock` : ''
  return [
    {
      id: 'flat',
      label: 'Flat',
      sub: 'no move',
      parent: null,
      scenario: { price: { kind: 'step', drop: 0 } },
      missing: null,
    },
    {
      id: 'step10',
      label: '−10% step',
      sub: 'held',
      parent: null,
      scenario: { price: { kind: 'step', drop: 0.1 } },
      missing: null,
    },
    {
      id: 'step25',
      label: '−25% step',
      sub: 'held',
      parent: null,
      scenario: { price: ref },
      missing: null,
    },
    {
      id: 'freeze8',
      label: `Venue freeze ${TREE_FREEZE_HOURS}h`,
      sub: 'at −25% step',
      parent: 'step25',
      scenario: { price: ref, venue: { freezeHours: TREE_FREEZE_HOURS } },
      missing: null,
    },
    {
      id: 'capFloor',
      label: floor ? `Exit ×${multText(floor.mult)}` : 'Everyone exits',
      sub: floor
        ? `${floor.source?.venueName ?? ''} everyone exits${floorLock} · at −25% step`
        : 'at −25% step',
      parent: 'step25',
      scenario: floorId ? { price: ref, venue: { exitCapacityPreset: floorId } } : null,
      missing: floorId ? null : TREE_FLOOR_MISSING,
    },
    {
      id: 'wick25',
      label: '−25% wick',
      sub: '4h, then recovers',
      parent: null,
      scenario: { price: { kind: 'wick', drop: 0.25, hours: 4 } },
      missing: null,
    },
    {
      id: 'oct10',
      label: 'Oct 10 replay',
      sub: 'ETH oracle path · sensitivity test',
      parent: null,
      scenario: replay ? { price: replay } : null,
      missing: replay ? null : replayMissing,
    },
  ]
}

/**
 * Time → x in [0, 1] on the tree's piecewise scale. The first minute, the first hour and
 * the 8h window each get room; a 48h replay still fits.
 */
export const TIME_KNOTS: readonly (readonly [number, number])[] = [
  [0, 0],
  [60, 0.05],
  [3_600, 0.2],
  [8 * 3_600, 0.48],
  [24 * 3_600, 0.72],
  [48 * 3_600, 0.9],
  [60 * 3_600, 1],
]

export const TIME_TICKS: readonly { s: number; label: string }[] = [
  { s: 0, label: 'now' },
  { s: 60, label: '1m' },
  { s: 3_600, label: '1h' },
  { s: 8 * 3_600, label: '8h' },
  { s: 24 * 3_600, label: '24h' },
  { s: 48 * 3_600, label: '48h' },
]

export function timeX(seconds: number): number {
  if (!(seconds > 0)) return 0
  for (let i = 1; i < TIME_KNOTS.length; i++) {
    const [s1, x1] = TIME_KNOTS[i]
    if (seconds <= s1) {
      const [s0, x0] = TIME_KNOTS[i - 1]
      return x0 + ((seconds - s0) / (s1 - s0)) * (x1 - x0)
    }
  }
  return 1
}

export type LaneEventKind = 'breach' | 'recall' | 'arm' | 'sale'

export interface LaneEvent {
  kind: LaneEventKind
  seconds: number
  x: number
  label: string
}

export interface LaneSegment {
  from: number
  to: number
  tone: Tone | 'idle'
}

export interface Lane extends LaneDef {
  result: StressResult | null
  leaf: LeafView
  events: LaneEvent[]
  segments: LaneSegment[]
  startX: number
  endX: number
  /** Changes only when what the lane SHOWS changes: the key for its draw-in animation. */
  signature: string
}

/** Events and coloured segments along one lane. */
export function laneTimeline(
  r: StressResult | null,
  startX = 0,
): { events: LaneEvent[]; segments: LaneSegment[]; endX: number } {
  if (!r || r.outcome === 'not_modelled') {
    return { events: [], segments: [{ from: startX, to: 1, tone: 'muted' }], endX: 1 }
  }
  const events: LaneEvent[] = []
  const push = (kind: LaneEventKind, s: number | null, label: string) => {
    if (s !== null) events.push({ kind, seconds: s, x: timeX(s), label })
  }
  push('breach', r.timeToBreachSeconds, 'line crossed')
  if (r.recallOpensAtSeconds !== null && r.recallOpensAtSeconds !== r.timeToBreachSeconds) {
    push('recall', r.recallOpensAtSeconds, 'venue answers')
  }
  push('arm', r.timeToArmSeconds, 'window armed')
  push('sale', r.timeToSaleSeconds, 'first sale')
  const endX = Math.max(startX, timeX(r.horizonSeconds))
  const xb = r.timeToBreachSeconds === null ? null : timeX(r.timeToBreachSeconds)
  const xa = r.timeToArmSeconds === null ? null : timeX(r.timeToArmSeconds)
  const xs = r.timeToSaleSeconds === null ? null : timeX(r.timeToSaleSeconds)
  const cuts: { x: number; tone: LaneSegment['tone'] }[] = [{ x: startX, tone: 'idle' }]
  if (xb !== null)
    cuts.push({
      x: Math.max(startX, xb),
      tone: r.outcome === 'recall_liquidated' ? 'call' : 'recall',
    })
  if (xa !== null) cuts.push({ x: Math.max(startX, xa), tone: 'armed' })
  if (xs !== null) cuts.push({ x: Math.max(startX, xs), tone: 'sold' })
  cuts.sort((a, b) => a.x - b.x)
  const segments: LaneSegment[] = []
  for (let i = 0; i < cuts.length; i++) {
    const to = i + 1 < cuts.length ? cuts[i + 1].x : endX
    if (to > cuts[i].x) segments.push({ from: cuts[i].x, to, tone: cuts[i].tone })
  }
  // An armed-then-cured lane ends where it was cured; it never turns red.
  return { events, segments, endX }
}

function laneSignature(r: StressResult | null, missing: string | null): string {
  if (!r) return `missing:${missing}`
  if (r.outcome === 'not_modelled') return `nm:${r.reason}`
  return [
    r.outcome,
    r.timeToBreachSeconds,
    r.timeToArmSeconds,
    r.timeToSaleSeconds,
    Math.round(r.exposedUsd),
  ].join('|')
}

/** Run every lane against one position. */
export function buildTree(position: StressPosition, defs: LaneDef[]): Lane[] {
  const out: Lane[] = []
  for (const d of defs) {
    const result = d.scenario ? runStress(position, d.scenario) : null
    const parent = d.parent ? out.find((l) => l.id === d.parent) : undefined
    const parentBreach =
      parent?.result &&
      parent.result.outcome !== 'not_modelled' &&
      parent.result.timeToBreachSeconds !== null
        ? timeX(parent.result.timeToBreachSeconds)
        : 0
    const startX = d.parent ? parentBreach : 0
    const tl = laneTimeline(result, startX)
    out.push({
      ...d,
      result,
      leaf: leafView(result, d.missing ?? undefined),
      events: tl.events,
      segments: tl.segments,
      startX,
      endX: tl.endX,
      signature: laneSignature(result, d.missing),
    })
  }
  return out
}

// ----------------------------------------------------------- crash test

export type CrashVerdict = 'cleared' | 'sold' | 'not_modelled'

export interface CrashLevel {
  drop: number
  title: string
  /** Reverse solve: the highest start LTV with no sale at this drop (toward risk). */
  limit: EdgeView
  /** The user's own position run at this drop. */
  node: StressResult
  verdict: CrashVerdict
  /**
   * The stamp's glyph and tone: the node's OWN outcome glyph (leafView), so the legend's
   * one-glyph-one-meaning rule holds — a CLEARED level that crossed the line and was
   * recalled shows ◆, one that armed and cured ▲, one whose sale call the recall covered ■.
   * ● only when the line was never crossed. (It used to stamp ● on all of them.)
   */
  glyph: Glyph
  tone: Tone
  userLtv: number
  line: number
  /** One line: the comparison, numbers only. */
  summary: string
}

export function crashLevel(
  drop: number,
  reverse: FrontierEdge,
  node: StressResult,
  userLtv: number,
  line: number,
): CrashLevel {
  const limit = edgeView(reverse, 'start LTV')
  const verdict: CrashVerdict =
    node.outcome === 'not_modelled' ? 'not_modelled' : node.outcome === 'sold' ? 'sold' : 'cleared'
  const leaf = leafView(node)
  const limitText =
    limit.state === 'found'
      ? `no sale up to start LTV ${limit.text}`
      : limit.state === 'beyond'
        ? 'no sale at any start LTV up to the line'
        : limit.state === 'already'
          ? 'sells at every start LTV'
          : limit.text
  return {
    drop,
    title: `−${Math.round(drop * 100)}%`,
    limit,
    node,
    verdict,
    glyph: leaf.glyph,
    tone: leaf.tone,
    userLtv,
    line,
    summary: `${limitText} · you start at ${pct(userLtv)}`,
  }
}

// ---------------------------------------------------------------- headline

export interface Headline {
  tone: Tone
  lead: string
  detail: string | null
}

/** A floor close: the call repaid all because a short recall would strand sub-floor debt. */
function isFloorClose(n: StressModelled | null): n is StressModelled {
  return !!n && n.outcome === 'sold' && n.saleReason === 'floor'
}

/**
 * The one sentence naming the nearest risk on the price axis (design §3). Venue axes are
 * NOT folded in: no combined "cheapest route to red" (design §2).
 */
export function nearestRisk(d: DistanceToDanger, sb: SandboxPosition): Headline {
  const p = sb.position
  const carry = p.tradeShape === 'carry'
  const delayed = p.membraneClass === 'delayed'
  const edge = edgeView(delayed ? d.price.arm : d.price.sale, 'held drop')
  const breach = edgeView(d.price.breach, 'held drop')
  // At a carry edge the recall need usually EQUALS the stock — the edge is where recall runs
  // out — so "needs $7,100, holds $7,100" would read as a typo. Say what the edge is instead.
  const recallLine = (n: StressModelled | null): string | null => {
    if (!carry || !n || n.recallNeededUsd === null) return null
    const need = n.recallNeededUsd
    const stock = n.recallAvailableUsd ?? 0
    const tail = ' Modelled recall, not a guarantee.'
    if (!(stock > 0))
      return `The chosen exit capacity returns nothing, so recall cannot hold the line.${tail}`
    // A measured level can leave a few dollars (×0.0001 behind a lock): never a bare $0.
    const amount = (x: number) => (x > 0 && x < 0.5 ? 'under $1' : usd(x))
    if (Math.abs(need - stock) <= Math.max(1, stock * 1e-3)) {
      return `That is where recall runs out: the chosen exit capacity holds ${amount(stock)}.${tail}`
    }
    return `Recall would need ${amount(need)}; the chosen exit capacity holds ${amount(stock)}.${tail}`
  }
  // The floor close (owner ruling 2026-10-04): the venue answered short of a whole-loan ask
  // and would have left debt under the floor, so that call repaid all and sold the rest.
  // Not a window, and not "recall runs out" — say what happened.
  const dMinText = usd(p.debtMinimumUsd ?? LIQ_DEBT_MINIMUM_USD)
  const floorLine = (n: StressModelled | null): string | null => {
    if (!isFloorClose(n)) return null
    const recalled = n.recallDrawnUsd ?? 0
    return (
      `There the venue returns ${usd(recalled)} of the ${usd(recalled + n.exposedUsd)} owed; the ` +
      `${usd(n.exposedUsd)} left would sit under the ${dMinText} debt floor, so that call repays ` +
      `the loan in full and sells ${usd(n.exposedUsd)} of collateral. Modelled recall, not a guarantee.`
    )
  }
  const floorVerb = `sells collateral: a short recall would leave debt under the ${dMinText} floor, so the loan is repaid in full`
  if (d.price.breach.status === 'not_applicable') {
    return { tone: 'muted', lead: 'Not modelled for these inputs.', detail: null }
  }
  const verb = delayed
    ? `arms the ${classView('delayed').windowHours}h window`
    : 'sells collateral (no window in this class)'
  // A carry position that starts over the line is recalled at once; say so before the edge.
  const overNow =
    carry && breach.state === 'already'
      ? `Already over the line: start LTV ${pct(sb.startLtv)} vs line ${pct(sb.line, 0)}, so recall fires at once.`
      : null
  const join = (...parts: (string | null)[]): string | null =>
    parts.filter(Boolean).join(' ') || null
  switch (edge.state) {
    case 'found': {
      const floor = isFloorClose(edge.node)
      const what = floor ? floorVerb : verb
      return {
        tone: floor ? 'sold' : delayed ? 'armed' : 'sold',
        lead:
          edge.text === '<1%'
            ? `A held drop under 1% ${what}.`
            : `A held drop past ${edge.text} ${what}.`,
        detail: carry
          ? join(
              overNow,
              floorLine(edge.node) ??
                recallLine(edge.node) ??
                (breach.state === 'found'
                  ? `The line is crossed past ${breach.text}; recall fires first.`
                  : null),
            )
          : 'Levered long: no venue recall, only the window defends.',
      }
    }
    case 'already':
      return {
        tone: 'sold',
        lead: delayed
          ? `Over the line with no shock: start LTV ${pct(sb.startLtv)} vs line ${pct(sb.line, 0)}.`
          : `Sells with no shock: start LTV ${pct(sb.startLtv)} vs line ${pct(sb.line, 0)}.`,
        detail: floorLine(edge.node) ?? recallLine(edge.node),
      }
    case 'beyond':
      return {
        tone: 'clear',
        lead: delayed
          ? `No held drop up to 99% arms the window.`
          : `No held drop up to 99% sells collateral.`,
        detail: overNow,
      }
    case 'na':
      return { tone: 'muted', lead: `Price axis: ${edge.text}.`, detail: null }
  }
}

// ----------------------------------------------------------------- swatch

export interface SwatchCell {
  key: string
  scenario: StressScenario
  result: StressResult
  leaf: LeafView
  /** Compact one-liner (swatchText). */
  text: string
}

export interface SwatchRow {
  key: string
  label: string
  cells: SwatchCell[]
}

export interface Swatch {
  cols: string[]
  rows: SwatchRow[]
}

export function shapeLabel(s: PriceShape): string {
  const d = (x: number) => `−${Math.round(x * 100)}%`
  switch (s.kind) {
    case 'step':
      return s.drop === 0 ? 'flat' : `${d(s.drop)} step`
    case 'linear':
      return `${d(s.drop)} over ${s.hours}h`
    case 'wick':
      return `${d(s.drop)} wick ${s.hours}h`
    case 'replay':
      return 'Oct 10 replay'
  }
}

export function venueLabel(v: VenueStress | undefined): string {
  if (!v) return 'chosen exit'
  if (v.capacityMult !== undefined && v.capacityMult !== 1) return `exit ×${v.capacityMult}`
  if (v.freezeHours) return `freeze ${v.freezeHours}h`
  return 'chosen exit'
}

/** The power-user grid: every price shape × every single-axis venue condition (no combos). */
export function buildSwatch(position: StressPosition, replay: PriceShape | null): Swatch {
  const shapes: PriceShape[] = [...DEFAULT_PRICE_SHAPES, ...(replay ? [replay] : [])]
  const venues: (VenueStress | undefined)[] =
    position.tradeShape === 'levered_long'
      ? [undefined]
      : [
          ...DEFAULT_CAPACITY_MULTS.map((m) => (m === 1 ? undefined : { capacityMult: m })),
          ...DEFAULT_FREEZE_HOURS.map((h) => ({ freezeHours: h })),
        ]
  return {
    cols: venues.map(venueLabel),
    rows: shapes.map((price) => ({
      key: shapeLabel(price),
      label: shapeLabel(price),
      cells: venues.map((venue) => {
        const scenario: StressScenario = venue ? { price, venue } : { price }
        const result = runStress(position, scenario)
        return {
          key: `${shapeLabel(price)}·${venueLabel(venue)}`,
          scenario,
          result,
          leaf: leafView(result),
          text: swatchText(result),
        }
      }),
    })),
  }
}

// ---------------------------------------------------------------- detail

export interface DetailRow {
  label: string
  value: string
  tone?: Tone
}

/** Every field the detail panel shows for one node. */
export function detailRows(r: StressResult): DetailRow[] {
  const rows: DetailRow[] = []
  if (r.outcome === 'not_modelled') {
    rows.push({ label: 'reason', value: notModelledText(r.reason), tone: 'muted' })
  } else {
    const leaf = leafView(r)
    rows.push({ label: 'outcome', value: `${leaf.glyph} ${leaf.title}`, tone: leaf.tone })
    rows.push({
      label: 'sold',
      value: r.exposedUsd > 0 ? usd(r.exposedUsd) : 'none',
      tone: r.exposedUsd > 0 ? 'sold' : undefined,
    })
    if (r.recallNeededUsd !== null) {
      rows.push({ label: 'recall drawn', value: usdOrNone(r.recallDrawnUsd) })
      rows.push({ label: 'needed to hold line', value: usdOrNone(r.recallNeededUsd) })
      rows.push({ label: 'venue stock', value: usdOrNone(r.recallAvailableUsd) })
    } else {
      rows.push({ label: 'recall', value: 'none (levered long)' })
    }
    rows.push({
      label: 'line crossed',
      value: r.timeToBreachSeconds === null ? 'never' : `at ${duration(r.timeToBreachSeconds)}`,
    })
    rows.push({
      label: 'time to arm',
      value:
        r.membraneClass === 'no-delay'
          ? 'no window'
          : r.timeToArmSeconds === null
            ? 'never armed'
            : duration(r.timeToArmSeconds),
      tone: r.timeToArmSeconds === null ? undefined : 'armed',
    })
    rows.push({
      label: 'first sale',
      value:
        r.timeToSaleSeconds === null
          ? 'none'
          : `${duration(r.timeToSaleSeconds)} · ${
              r.saleReason === 'expiry'
                ? 'window expired'
                : r.saleReason === 'floor'
                  ? 'debt floor: loan repaid in full'
                  : r.membraneClass === 'no-delay'
                    ? 'over the line'
                    : 'past the band'
            }`,
      tone: r.timeToSaleSeconds === null ? undefined : 'sold',
    })
    rows.push({ label: 'start LTV', value: pct(r.startLtv) })
    rows.push({ label: 'peak LTV', value: pct(r.peakLtv) })
    rows.push({
      label: 'landing LTV',
      value:
        r.landingLtv === null
          ? 'no collateral left'
          : r.landingLtv === 0
            ? 'debt closed'
            : pct(r.landingLtv),
    })
    rows.push({ label: 'debt closed', value: r.closedUsd > 0 ? usd(r.closedUsd) : 'none' })
    if (r.badDebtUsd > 0) rows.push({ label: 'bad debt', value: usd(r.badDebtUsd), tone: 'sold' })
    rows.push({ label: 'sale calls', value: String(r.sales) })
    rows.push({ label: 'horizon', value: duration(r.horizonSeconds) })
  }
  rows.push({ label: 'scenario', value: r.scenarioId })
  rows.push({ label: 'cell key', value: r.cellKey })
  rows.push({ label: 'code', value: r.codeVersion })
  return rows
}

// ------------------------------------------------------------- selection

/** What the detail panel is pointed at. Resolved against the CURRENT model, so it follows input changes. */
export type Selection =
  | { kind: 'lane'; id: LaneId }
  | { kind: 'swatch'; row: number; col: number }
  | {
      kind: 'edge'
      axis: 'price' | 'wick' | 'capacity' | 'freeze'
      edge: 'breach' | 'arm' | 'sale'
    }
  | { kind: 'crash'; index: number }

export interface ResolvedSelection {
  title: string
  sub: string
  result: StressResult | null
  /** Why there is no result. */
  missing: string | null
}

const EDGE_NAME = { breach: 'line crossed', arm: 'window arms', sale: 'first sale' } as const

export function resolveSelection(m: FrontierModel, sel: Selection): ResolvedSelection {
  switch (sel.kind) {
    case 'lane': {
      const lane = m.tree.find((l) => l.id === sel.id) ?? m.tree[0]
      return {
        title: lane.label,
        sub: lane.sub,
        result: lane.result,
        missing: lane.result ? null : lane.missing,
      }
    }
    case 'swatch': {
      const row = m.swatch.rows[sel.row]
      const cell = row?.cells[sel.col]
      if (!row || !cell)
        return { title: 'Swatch', sub: '', result: null, missing: 'cell not in this grid' }
      return { title: row.label, sub: m.swatch.cols[sel.col], result: cell.result, missing: null }
    }
    case 'crash': {
      const c = m.crash[sel.index] ?? m.crash[0]
      return {
        title: `Crash test ${c.title}`,
        sub: 'held step · your position',
        result: c.node,
        missing: null,
      }
    }
    case 'edge': {
      const axis =
        sel.axis === 'price'
          ? {
              name: 'Price · held drop',
              breach: m.dtd.price.breach,
              arm: m.dtd.price.arm,
              sale: m.dtd.price.sale,
            }
          : sel.axis === 'wick'
            ? { name: 'Price · 1-minute wick', breach: null, arm: null, sale: m.dtd.saleAtShock }
            : sel.axis === 'capacity'
              ? {
                  name: 'Venue exit cut · at −25% step',
                  breach: null,
                  arm: m.dtd.capacity.arm,
                  sale: m.dtd.capacity.sale,
                }
              : {
                  name: 'Venue freeze · at −25% step',
                  breach: null,
                  arm: m.dtd.freeze.arm,
                  sale: m.dtd.freeze.sale,
                }
      const edge = axis[sel.edge]
      const view = edge ? edgeView(edge, 'shock') : null
      return {
        title: `${axis.name}: ${EDGE_NAME[sel.edge]}`,
        sub: view ? `edge ${view.text} · node just past it` : 'no such edge on this axis',
        result: view?.node ?? null,
        missing: view?.node ? null : view ? view.hint : 'no such edge on this axis',
      }
    }
  }
}

// ------------------------------------------------------------- the model

export interface FrontierModel {
  sandbox: SandboxPosition
  dtd: DistanceToDanger
  headline: Headline
  tree: Lane[]
  crash: CrashLevel[]
  swatch: Swatch
  computeMs: number
}

/** Everything the screen needs for one input set. Pure; several hundred stress runs. */
export function computeFrontier(
  inputs: SandboxInputs,
  replay: PriceShape | null,
  replayMissing?: string,
  now: () => number = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
): FrontierModel {
  const t0 = now()
  const sandbox = buildStressPosition(inputs)
  const p = sandbox.position
  const dtd = distanceToDanger(p)
  const tree = buildTree(p, treeLanes(inputs.capacity, replay, replayMissing))
  const [d50, d60] = REVERSE_SOLVE_DROPS
  const crash = [
    crashLevel(
      d50,
      dtd.reverse.at50,
      runStress(p, { price: { kind: 'step', drop: d50 } }),
      sandbox.startLtv,
      sandbox.line,
    ),
    crashLevel(
      d60,
      dtd.reverse.at60,
      runStress(p, { price: { kind: 'step', drop: d60 } }),
      sandbox.startLtv,
      sandbox.line,
    ),
  ]
  return {
    sandbox,
    dtd,
    headline: nearestRisk(dtd, sandbox),
    tree,
    crash,
    swatch: buildSwatch(p, replay),
    computeMs: now() - t0,
  }
}
