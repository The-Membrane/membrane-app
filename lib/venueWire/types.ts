/**
 * THE WIRE — Membrane's venue news, built from anomalies against each venue's own history.
 *
 * Owner direction 2026-10-11 (the Bloomberg model, board Q13; design/DESIGN_RULES.md §5b, §4):
 * report anything that moves a venue's risk or reward. Asset prices count only when they move
 * a venue or a position: collateral moves past historical quantiles, stablecoin depegs, LST
 * discounts to NAV, oracle deviations. Every story is a deterministic template filled from
 * measured data, never generated prose, and carries three labels: measured change, observed
 * driver, possible leading signal. No probabilities, no forecasts, no verdict words.
 */

/** What a story is about: one venue, or one asset whose price moves venues and positions. */
export interface Subject {
  kind: 'venue' | 'asset'
  /** Stable id: a venue-stress venue key (`aave-core-usdc`) or an asset key (`eth`, `steth`). */
  id: string
  /** The reader's name for it: "Aave USDC", "stETH". */
  label: string
}

export type MetricKey =
  /** Withdrawable cash as % of supply (= 100 − utilisation). */
  | 'idleCashPct'
  /** What can leave now, in the venue's token (USD for $1 stables). MetaMorpho: first in line. */
  | 'exitCapacity'
  | 'utilisationPct'
  /** Variable borrow APR %. Aave and Spark only: the MetaMorpho column is a queue length. */
  | 'borrowAprPct'
  /** LST discount to NAV in bps: (1 − market price / redemption value) × 1e4. */
  | 'navDiscountBps'
  /** Stablecoin discount to $1 in bps: (1 − price) × 1e4. */
  | 'depegBps'
  /** |oracle / exchange − 1| in bps. */
  | 'oracleDeviationBps'
  /** 24 h price change in %. */
  | 'priceMove24hPct'

/** Which end of the subject's own history the value sits at. */
export type Tail = 'low' | 'high'

/** tail: beyond p5 / p95. extreme: beyond p1 / p99. record: beyond every prior reading. run: a sustained tail. */
export type Severity = 'tail' | 'extreme' | 'record' | 'run'

/** One measured series. `t` ascending (unix s); `v[i]` null = no reading at t[i]. */
export interface Series {
  subject: Subject
  metric: MetricKey
  t: number[]
  v: (number | null)[]
  /** Readings before this time are not part of the baseline (venue below its material size). */
  fromTs: number
  /** Display unit of the value: 'pct', 'bps', 'usd', or a token symbol ("WETH"). */
  unit: string
  /** Where the numbers come from, in one line (§4: every series names its true source). */
  source: string
}

/** Percentile bands of one series over its own prior history (linear interpolation). */
export interface Bands {
  n: number
  fromTs: number
  toTs: number
  min: number
  p1: number
  p5: number
  p10: number
  p25: number
  p50: number
  p75: number
  p90: number
  p95: number
  p99: number
  max: number
}

/** "Lowest since <ts>": the last earlier reading at or beyond the value. ts null = on record. */
export interface Since {
  ts: number | null
  days: number
}

/** A series evaluated at one time. */
export interface Baseline {
  subject: Subject
  metric: MetricKey
  unit: string
  source: string
  /** Time of the newest reading used. */
  at: number
  /** The newest reading. */
  latest: number
  /**
   * The values the detector judges, per tail: the least extreme of the last
   * `persistReadings` readings, so a one-hour transient never makes a story.
   */
  guard: { low: number; high: number }
  /** Prior history only: the readings being judged are not in their own baseline. */
  bands: Bands
  lowestSince: Since
  highestSince: Since
}

/** Why a series produced no verdict. A quiet feed must never read as all-clear. */
export interface Uncovered {
  /** A subject id, or an input name when a whole input is missing. */
  subject: string
  metric: MetricKey | 'state' | 'all'
  reason: 'no-data' | 'short-history' | 'stale' | 'input-missing'
  detail: string
}

/**
 * level: at its reading time the value was the lowest (highest) since `since`.
 * run:   at the evaluation time the value has stayed in its tail band for `run.hours`, the
 *        longest such run since `since`.
 */
export interface Anomaly {
  kind: 'level' | 'run'
  /** The series evaluated at the reading the story is about. */
  baseline: Baseline
  tail: Tail
  severity: Severity
  since: Since
  run?: { from: number; hours: number; edge: number }
}

/** A venue status flag that switched inside the state window. */
export interface StateChange {
  kind: 'state'
  subject: Subject
  flag: 'paused' | 'frozen'
  on: boolean
  at: number
  block: number | null
  /** Switched on: the previous time the flag was on, null when never (on record). */
  previous: number | null
  /** Switched off: when the run that just ended began. */
  runFrom: number | null
  recordFromTs: number
  source: string
}

export type Finding = Anomaly | StateChange

export interface StoryLabels {
  /** What changed, with the numbers. */
  measured: string
  /** What the data shows moved with it. Never a guess at why. */
  driver: string
  /** What this has come before, stated as a possibility, never as odds. */
  signal: string
}

export type ImpactAxis = 'risk' | 'reward'

export interface Impact {
  axis: ImpactAxis
  /** The reader's words: "exit risk up", "borrow cost up". */
  effect: string
  /** Rank key. Deterministic product of the parts below; not a probability. */
  score: number
  parts: { weight: number; severity: number; magnitude: number; span: number }
}

export interface WireStory {
  /** Deterministic: subject, metric, tail and reading hour. */
  id: string
  subject: Subject
  metric: MetricKey | 'state'
  tail: Tail | 'on' | 'off'
  severity: Severity | 'state'
  headline: string
  labels: StoryLabels
  value: number | null
  unit: string
  since: Since
  bands: Bands | null
  impact: Impact
  /** Venue ids this story moves (the subject itself for a venue). */
  affects: string[]
  /** Other anomalies on the same subject with the same effect, folded into this story (§3: say each fact once). */
  also: MetricKey[]
  at: number
  source: string
  /** The input behind it is older than the stale limit: hatch it, suppress its headline (§4). */
  stale: boolean
}
