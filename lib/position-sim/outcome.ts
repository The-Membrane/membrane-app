import type { Comparison, SimRun } from './types'

/**
 * The one-line outcome — "liquidated there, survived here" — derived from the two runs.
 *
 * Only `kind === 'liquidation'` events count: a Membrane 'recall' or 'cure' repays from
 * venue capital with nothing sold and no fee, which is exactly the survival the line is
 * meant to show. `wiped` (no collateral left) is named as such — it is worse than
 * liquidated and the line must not soften it.
 */

export interface EngineOutcome {
  /** True if at least one collateral-seizing liquidation fired. */
  liquidated: boolean
  /** Unix seconds of the first liquidation, or null. */
  firstAt: number | null
  wiped: boolean
}

export interface Outcome {
  source: EngineOutcome
  membrane: EngineOutcome
  /** The sentence. Never softened, never blended. */
  line: string
}

export function engineOutcome(run: SimRun): EngineOutcome {
  const first = run.events.find((e) => e.kind === 'liquidation')
  return { liquidated: first != null, firstAt: first ? first.ts : null, wiped: run.wiped }
}

/** "10 Oct 21:14 UTC" — the price path is UTC minute rounds, so the clock is UTC. */
export function fmtUtcMinute(ts: number): string {
  const d = new Date(ts * 1000)
  const month = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${d.getUTCDate()} ${month} ${hh}:${mm} UTC`
}

function verb(o: EngineOutcome): string {
  if (o.wiped) return 'wiped out'
  return 'liquidated'
}

export function outcomeLine(cmp: Comparison): Outcome {
  const source = engineOutcome(cmp.source)
  const membrane = engineOutcome(cmp.membrane)
  const src = cmp.position.label

  let line: string
  if (source.liquidated && !membrane.liquidated) {
    line = `${cap(verb(source))} on ${src} at ${fmtUtcMinute(source.firstAt!)} · survived on Membrane`
  } else if (!source.liquidated && membrane.liquidated) {
    line = `Survived on ${src} · ${verb(membrane)} on Membrane at ${fmtUtcMinute(membrane.firstAt!)}`
  } else if (source.liquidated && membrane.liquidated) {
    line = `${cap(verb(source))} on ${src} at ${fmtUtcMinute(source.firstAt!)} · ${verb(membrane)} on Membrane at ${fmtUtcMinute(membrane.firstAt!)}`
  } else {
    line = `Survived on ${src} · survived on Membrane`
  }
  return { source, membrane, line }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
