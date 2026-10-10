// RULE: Numbers come from the code; change the code and the glossary follows.
// Every threshold, multiple, window and duration below is interpolated from the
// constant the running code compares against (scripts/lib/alarmRules.mjs
// ALARM_THRESHOLDS, components/Radar/radarLogic.ts COVERAGE_* /
// COOLDOWN_EXPOSED_SECONDS, lib/position-sim/membrane.ts CURE_WINDOW_HOURS /
// BORROW_LTV_GAP / MAX_THRESHOLD_TO_DELAY) — never typed as a literal. The blind-spot term is
// built from UNCOVERED_SIGNALS. tests/unit/glossary.test.ts fails on a digit in
// this file's code, an alarm kind without a term, or a blind-spot clause for a
// signal the code does not list.
//
// Glossary terms — pure data, JSX-free so tests/unit/glossary.test.ts reads it
// directly. Every definition is measured from code; the source is recorded per
// term in `source` (repo path) so a reviewer can re-check the number.
//
// Owner ruling 2026-09-25 ("align shared words"): exit LEGS (Radar/Strats stress
// model) and size TIERS (Carry capacity fill order) are two different concepts.
// Both use "cooldown"; neither uses "cooling" in user-facing text.

import {
  ALARM_THRESHOLDS,
  HEADROOM_BLIND_SIGNAL,
  UNCOVERED_SIGNALS,
} from '@/scripts/lib/alarmRules.mjs'
import {
  COOLDOWN_EXPOSED_SECONDS,
  COVERAGE_CAUTION,
  COVERAGE_CLEAR,
  fmtDuration,
} from '@/components/Radar/radarLogic'
import {
  BORROW_LTV_GAP,
  CURE_WINDOW_HOURS,
  MAX_THRESHOLD_TO_DELAY,
} from '@/lib/position-sim/membrane'

export type GlossaryGroupId = 'liquidation' | 'legs' | 'verdicts' | 'tiers' | 'depth' | 'alarms'

export type GlossaryTerm = {
  /** Anchor id — /ethereum/glossary#<id> is the citable URL. Unique. */
  id: string
  term: string
  group: GlossaryGroupId
  definition: string
  /** Repo path the definition is measured from. */
  source: string
  /** For alarm rules: the rule kind as the alarm system names it. */
  alarmKind?: string
}

export const GLOSSARY_GROUPS: { id: GlossaryGroupId; title: string }[] = [
  { id: 'liquidation', title: 'Liquidation' },
  { id: 'legs', title: 'Exit legs' },
  { id: 'verdicts', title: 'Verdicts' },
  { id: 'tiers', title: 'Size tiers' },
  { id: 'depth', title: 'Depth' },
  { id: 'alarms', title: 'Venue alarms' },
]

const RADAR = 'components/Radar/radarLogic.ts'
const TIERS = 'components/Carry/utils.ts'
const ALARMS = 'scripts/lib/alarmRules.mjs'
const LIQ = 'lib/position-sim/membrane.ts'

const T = ALARM_THRESHOLDS
const x = (n: number): string => `${n}x`
const pct = (n: number): string => `${n}%`
// fmtDuration gives "<n>d" for whole days; spell it out ("1 day", "7 days").
const PLURAL = new Intl.PluralRules('en')
const days = (n: number): string => `${n} ${PLURAL.select(n) === 'one' ? 'day' : 'days'}`
const dayWindow = (n: number): string => `${n}-day`
const secsAsDays = (secs: number): string => {
  const d = fmtDuration(secs)
  const whole = /^(?<n>.+)d$/.exec(d)?.groups?.n
  return whole !== undefined ? days(Number(whole)) : d
}
const COOLDOWN_LIMIT = secsAsDays(COOLDOWN_EXPOSED_SECONDS)
// Fractions (0.04) as whole percents ("4%"); "points" for an LTV difference.
const PERCENT = new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 2 })
const fracPct = (f: number): string => PERCENT.format(f)
const fracPoints = (f: number): string => `${PERCENT.format(f).replace('%', '')} percentage points`
const WINDOW = `${CURE_WINDOW_HOURS}-hour window`

// One clause per signal the alarm can be blind to, keyed by UNCOVERED_SIGNALS id
// (plus the per-venue headroom signal). The blind-spot definition lists exactly
// the signals the code lists; the test fails on a clause for any other id.
export const BLIND_SPOT_CLAUSES: Record<string, string> = {
  depth_vs_book: 'depth-vs-book without a verified depth market',
  terms_page_changes: 'terms changes without a watched terms page',
  [HEADROOM_BLIND_SIGNAL.id]:
    'instant-exit headroom where neither instant liquidity nor swap-out capacity is recorded',
}
const blindSpotDefinition = (): string => {
  const ids = [...UNCOVERED_SIGNALS.map((u) => u.id), HEADROOM_BLIND_SIGNAL.id]
  const clauses = ids.map((id) => BLIND_SPOT_CLAUSES[id] ?? id)
  return `A signal the alarm cannot evaluate at a venue: ${clauses.join('; ')}.`
}

export const GLOSSARY_TERMS: GlossaryTerm[] = [
  // ── Liquidation (Practice page + landing) ────────────────────────────────
  {
    id: 'liquidation-line',
    term: 'Liquidation line',
    group: 'liquidation',
    definition: `The asset's max LTV. Crossing it does not sell anything: it starts the ${WINDOW}. Your borrow line sits ${fracPoints(BORROW_LTV_GAP)} below it.`,
    source: LIQ,
  },
  {
    id: 'window',
    term: `${CURE_WINDOW_HOURS}-hour window`,
    group: 'liquidation',
    definition: `The delay between crossing the liquidation line and any sale: ${CURE_WINDOW_HOURS} hours. Repaying inside it restores your borrow line (the liquidation line minus ${fracPoints(BORROW_LTV_GAP)}) and nothing is sold.`,
    source: LIQ,
  },
  {
    id: 'break-line',
    term: 'Break line',
    group: 'liquidation',
    definition: `The liquidation line raised by a band of ${fracPct(MAX_THRESHOLD_TO_DELAY)} of the line. Past it the ${WINDOW} no longer applies: the sale is immediate and partial, down to the borrow line.`,
    source: LIQ,
  },

  // ── Exit legs (Radar/Strats stress model) ────────────────────────────────
  {
    id: 'instant-leg',
    term: 'Instant leg',
    group: 'legs',
    definition:
      'Recorded instant venue inventory divided by your position size. This is a size proxy, not a wallet-specific withdrawal quote: permissions, route and execution remain unverified. Scored only where inventory is read; cooldown vaults have no instant leg.',
    source: RADAR,
  },
  {
    id: 'cooldown-leg',
    term: 'Cooldown leg',
    group: 'legs',
    definition: `The recorded cooldown gate on a cooldown vault. It delays all of an exit regardless of size: up to ${COOLDOWN_LIMIT} is caution, longer than ${COOLDOWN_LIMIT} is exposed.`,
    source: RADAR,
  },
  {
    id: 'flow-leg',
    term: 'Flow leg',
    group: 'legs',
    definition:
      'Historical aggregate outflow is context for how much left a venue in a measured window, not proof that your position can exit. A maximum observed outflow needs certified complete-window coverage; otherwise it is unavailable. Radar excludes legacy flow from the exit verdict.',
    source: RADAR,
  },

  // ── Verdicts ─────────────────────────────────────────────────────────────
  {
    id: 'clear',
    term: 'Clear',
    group: 'verdicts',
    definition: `The ${x(COVERAGE_CLEAR)} size-coverage reference is descriptive, not proof that this wallet can exit. Recorded inventory alone cannot make a held venue clear. A venue verdict uses its weakest applicable leg, never an average; no position to exit is clear.`,
    source: RADAR,
  },
  {
    id: 'caution',
    term: 'Caution',
    group: 'verdicts',
    definition: `Recorded instant inventory covers your size at least ${x(COVERAGE_CAUTION)}, even if it exceeds ${x(COVERAGE_CLEAR)}, but holder-specific execution remains unverified; a cooldown gate of ${COOLDOWN_LIMIT} or shorter is also caution. A venue with no recorded instant inventory or cooldown gate is caution.`,
    source: RADAR,
  },
  {
    id: 'exposed',
    term: 'Exposed',
    group: 'verdicts',
    definition: `Recorded instant inventory covers under ${x(COVERAGE_CAUTION)} your size, or a cooldown gate is longer than ${COOLDOWN_LIMIT}; the weakest applicable leg sets the verdict.`,
    source: RADAR,
  },

  // ── Size tiers (Carry capacity fill order) ───────────────────────────────
  {
    id: 'instant-tier',
    term: 'Instant tier',
    group: 'tiers',
    definition:
      "The first slice of an exit, up to the venue's instant depth, priced at the instant exit cost. Size fills tiers in order: instant, then cooldown, then stranded.",
    source: TIERS,
  },
  {
    id: 'cooldown-tier',
    term: 'Cooldown tier',
    group: 'tiers',
    definition:
      'The next slice of an exit after instant depth is used up, up to the cooldown depth, priced at the cooldown exit cost.',
    source: TIERS,
  },
  {
    id: 'stranded',
    term: 'Stranded',
    group: 'tiers',
    definition:
      'Exit size beyond instant plus cooldown depth, priced at the stranded exit cost. Blended exit cost is the size-weighted mix of all three tiers.',
    source: TIERS,
  },

  // ── Depth ────────────────────────────────────────────────────────────────
  {
    id: 'swap-out-capacity',
    term: 'Swap-out capacity',
    group: 'depth',
    definition: `The largest exit from a venue token that stays within a stated cost, fees included, summed across the venue's independent exit pools. Cost is value received against the token's redemption value, both from on-chain quotes at one block; the stable you receive counts at face value. A pool's raw reserve is only its ceiling, not an exit at par. For a venue with no instant-liquidity read, the suspended thin-headroom rule would use capacity within ${pct(T.headroom_thin.poolCostPct)} cost.`,
    source: 'scripts/lib/depthCurve.mjs · lib/venueCapacity/capacityCurve.ts',
  },

  // ── Venue alarms ─────────────────────────────────────────────────────────
  {
    id: 'gate-change',
    term: 'Gate change',
    group: 'alarms',
    alarmKind: 'gate_change',
    definition: `Alarm. A recorded cooldown-duration change or instant-liquidity shift in the last ${T.gate_change.windowHours} hours. A page-text edit alone does not establish that the gate moved.`,
    source: ALARMS,
  },
  {
    id: 'terms-page-notice',
    term: 'Terms page notice',
    group: 'alarms',
    alarmKind: 'terms_page_notice',
    definition: `Notice. Each observed edit to the official redemption-terms page gets its own notice for ${T.terms_page_notice.windowHours} hours. Exit impact is unclassified until the changed terms are reviewed; the page edit alone does not prove a cooldown or liquidity change.`,
    source: ALARMS,
  },
  {
    id: 'drawdown-fast',
    term: 'Fast drawdown',
    group: 'alarms',
    alarmKind: 'drawdown_fast',
    definition: `Alarm. The venue's capacity (instant liquidity where read, else total assets) is more than ${pct(T.drawdown_fast.alarmFallPct)} below its ${dayWindow(T.drawdown_fast.windowDays)} peak.`,
    source: ALARMS,
  },
  {
    id: 'net-outflow-streak',
    term: 'Net outflow streak',
    group: 'alarms',
    alarmKind: 'net_outflow_streak',
    definition: `Suspended alarm. Its intended rule is consecutive days of net outflow whose total exceeds ${pct(T.net_outflow_streak.minPctOfTvl)} of TVL: watch at ${days(T.net_outflow_streak.watchDays)}, alarm at ${T.net_outflow_streak.alarmDays}. Legacy flow rows do not certify complete days, including quiet days, so no streak or break can be trusted yet.`,
    source: ALARMS,
  },
  {
    id: 'headroom-thin',
    term: 'Thin headroom',
    group: 'alarms',
    alarmKind: 'headroom_thin',
    definition: `Suspended alarm. Its intended ratio compares instant exit liquidity with the worst observed single-day outflow in a certified complete ${T.headroom_thin.windowDays}-day window: watch under ${x(T.headroom_thin.watch)}, alarm under ${x(T.headroom_thin.alarm)}. Where a venue has no instant-liquidity read, its swap-out capacity within ${pct(T.headroom_thin.poolCostPct)} cost is used instead (the raw pool reserve only when no quoted curve exists). The vault's own redemption counts as capacity too: with no cooldown it adds to the fast exit; with a cooldown it counts toward the total and includes the wait. Pool-only headroom stays at ${T.headroom_thin.poolMaxSeverity} unless even the total cannot cover the day. Legacy flow rows do not certify the complete window, so the ratio and alarm are unavailable.`,
    source: ALARMS,
  },
  {
    id: 'utilization',
    term: 'Utilization',
    group: 'alarms',
    alarmKind: 'utilization',
    definition: `Debt divided by debt plus available liquidity on a lending reserve. Watch above ${pct(T.utilization.watchPct)}, alarm above ${pct(T.utilization.alarmPct)}.`,
    source: ALARMS,
  },
  {
    id: 'depth-skew',
    term: 'Depth skew',
    group: 'alarms',
    alarmKind: 'depth_skew',
    definition: `The larger side of a venue's exit pool as a share of the pool. Watch above ${pct(T.depth_skew.watchPct)}, alarm above ${pct(T.depth_skew.alarmPct)}.`,
    source: ALARMS,
  },
  {
    id: 'depth-collapse',
    term: 'Depth collapse',
    group: 'alarms',
    alarmKind: 'depth_collapse',
    definition: `The raw swap-out reserve (the swap-into side of the exit pools, at face value) below its ${dayWindow(T.depth_collapse.windowDays)} peak. Watch at a fall above ${pct(T.depth_collapse.watchFallPct)}, alarm above ${pct(T.depth_collapse.alarmFallPct)}.`,
    source: ALARMS,
  },
  {
    id: 'blind-spot',
    term: 'Blind spot',
    group: 'alarms',
    definition: blindSpotDefinition(),
    source: ALARMS,
  },
]

/** The citable URL of one term. */
export const termUrl = (siteUrl: string, chain: string, id: string): string =>
  `${siteUrl}/${chain}/glossary#${id}`

/** schema.org DefinedTermSet for the page's JSON-LD block. */
export const buildDefinedTermSet = (siteUrl: string, chain: string) => ({
  '@context': 'https://schema.org',
  '@type': 'DefinedTermSet',
  '@id': `${siteUrl}/${chain}/glossary`,
  name: 'Membrane glossary',
  url: `${siteUrl}/${chain}/glossary`,
  publisher: { '@type': 'Organization', name: 'Membrane', url: siteUrl },
  hasDefinedTerm: GLOSSARY_TERMS.map((t) => ({
    '@type': 'DefinedTerm',
    '@id': termUrl(siteUrl, chain, t.id),
    name: t.term,
    description: t.definition,
    url: termUrl(siteUrl, chain, t.id),
    inDefinedTermSet: `${siteUrl}/${chain}/glossary`,
  })),
})
