/**
 * The anti-flap state machine every rule runs through.
 *
 * A rule turns a position into one number per key (health factor, depeg bps, coverage
 * ratio …). This tracker turns that number into level transitions:
 *
 *   enter      a level is entered when the value crosses its threshold
 *   confirm    a non-critical level must be breached on `confirm` consecutive samples
 *              before it fires (one wick does not page anyone). Critical fires at once.
 *   band       a level is HELD until the value recovers past threshold ± band (hysteresis)
 *   dwellS     and stays recovered for dwellS seconds. Only then does the level drop and a
 *              clear/ease is emitted — so an all-clear is never sent into a bounce.
 *   cooldownS  after a clear, re-entering WATCH within cooldownS of the last watch message
 *              raises the state silently ('suppressed'). Warn and critical always speak:
 *              their all-clear was spoken too (engine.isNotifiable), so silence after it
 *              would read as "still fine".
 *
 * Escalation is never delayed by dwell or cooldown: things getting worse always speak.
 */

import type { Level, Severity, TransitionKind } from './types'
import { SEVERITIES } from './types'

export interface LevelSpec {
  /** 'below': alert when the value falls under a threshold (health factor). 'above': rises over it. */
  direction: 'below' | 'above'
  /** Enter thresholds. Omit a severity to disable it. */
  enter: Partial<Record<Severity, number>>
  /** Hysteresis band, in the value's own units. */
  band: number
  dwellS: number
  confirm: number
  cooldownS: number
}

export interface TrackerState {
  level: Level
  /** Epoch seconds the current level was entered; null before the first sample. */
  since: number | null
  /** Consecutive samples breaching a level above the current one. */
  pending: number
  /** Epoch seconds the value first sat recovered below the current level, or null. */
  recoverSince: number | null
  /** Epoch seconds of the last EMITTED fire/escalate into each level (index 1..3). */
  lastFired: [null, number | null, number | null, number | null]
  lastClear: number | null
  /** Highest level reached since the last clear. Decides whether a clear is worth sending. */
  peak: Level
}

export interface Step {
  state: TrackerState
  transition: {
    kind: TransitionKind
    from: Level
    to: Level
    threshold: number
    peak: Level
  } | null
}

export const initialTracker = (): TrackerState => ({
  level: 0,
  since: null,
  pending: 0,
  recoverSince: null,
  lastFired: [null, null, null, null],
  lastClear: null,
  peak: 0,
})

const breaches = (spec: LevelSpec, v: number, thr: number) =>
  spec.direction === 'below' ? v < thr : v > thr

const holds = (spec: LevelSpec, v: number, thr: number) =>
  spec.direction === 'below' ? v < thr + spec.band : v > thr - spec.band

/** Highest level whose enter threshold the value breaches. */
export function rawLevel(spec: LevelSpec, v: number): Level {
  let out: Level = 0
  SEVERITIES.forEach((s, i) => {
    const thr = spec.enter[s]
    if (thr !== undefined && breaches(spec, v, thr)) out = (i + 1) as Level
  })
  return out
}

/** Highest level the value still HOLDS once the hysteresis band is applied. */
export function heldLevel(spec: LevelSpec, v: number): Level {
  let out: Level = 0
  SEVERITIES.forEach((s, i) => {
    const thr = spec.enter[s]
    if (thr !== undefined && holds(spec, v, thr)) out = (i + 1) as Level
  })
  return out
}

/** Throws when thresholds are out of order — a 'below' spec needs watch > warn > critical. */
export function validateSpec(spec: LevelSpec): void {
  const defined = SEVERITIES.map((s) => spec.enter[s]).filter((t): t is number => t !== undefined)
  for (let i = 1; i < defined.length; i++) {
    const ok =
      spec.direction === 'below' ? defined[i] < defined[i - 1] : defined[i] > defined[i - 1]
    if (!ok)
      throw new Error(
        `level thresholds out of order for direction '${spec.direction}': ${defined.join(', ')}`,
      )
  }
  if (!(spec.band >= 0) || !(spec.dwellS >= 0) || !(spec.cooldownS >= 0) || !(spec.confirm >= 1)) {
    throw new Error('band, dwellS and cooldownS must be >= 0 and confirm >= 1')
  }
}

const thresholdOf = (spec: LevelSpec, l: Level): number => spec.enter[SEVERITIES[l - 1]] as number

/** Advance one tracker by one sample. Pure: returns a new state object. */
export function stepLevel(spec: LevelSpec, st: TrackerState, value: number, ts: number): Step {
  const raw = rawLevel(spec, value)

  if (raw > st.level) {
    const pending = st.pending + 1
    if (raw < 3 && pending < spec.confirm) {
      return { state: { ...st, pending, recoverSince: null }, transition: null }
    }
    const from = st.level
    const to = raw
    const last = st.lastFired[to]
    const suppressed = to === 1 && spec.cooldownS > 0 && last !== null && ts - last < spec.cooldownS
    const lastFired = [...st.lastFired] as TrackerState['lastFired']
    if (!suppressed) lastFired[to as 1 | 2 | 3] = ts
    const peak = Math.max(st.peak, to) as Level
    return {
      state: { ...st, level: to, since: ts, pending: 0, recoverSince: null, lastFired, peak },
      transition: {
        kind: suppressed ? 'suppressed' : from === 0 ? 'fire' : 'escalate',
        from,
        to,
        threshold: thresholdOf(spec, to),
        peak,
      },
    }
  }

  const base = { ...st, pending: 0, since: st.since ?? ts }
  if (st.level === 0) return { state: base, transition: null }

  const held = heldLevel(spec, value)
  if (held >= st.level) return { state: { ...base, recoverSince: null }, transition: null }

  const recoverSince = st.recoverSince ?? ts
  if (ts - recoverSince < spec.dwellS) return { state: { ...base, recoverSince }, transition: null }

  const from = st.level
  const to = held
  const thr = thresholdOf(spec, from)
  return {
    state: {
      ...base,
      level: to,
      since: ts,
      recoverSince: null,
      lastClear: to === 0 ? ts : st.lastClear,
      peak: to === 0 ? 0 : st.peak,
    },
    transition: {
      kind: to === 0 ? 'clear' : 'ease',
      from,
      to,
      threshold: spec.direction === 'below' ? thr + spec.band : thr - spec.band,
      peak: st.peak,
    },
  }
}
