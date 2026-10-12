/**
 * Rank stories by impact on a venue's risk or reward (board Q13 point 1: rank by impact on
 * the trade, not by size). The score is a product of four stated parts, so any order can be
 * explained from the story itself. It is a rank key, not a probability.
 *
 *   weight     risk 1.0, reward 0.6: exits and collateral before yield
 *   severity   tail 1, sustained run 1, extreme 2, record 3; a freeze 3, a flag cleared 1;
 *              a pause 7, so it outranks every level story (7 × 3 > 3 × 3 × 2)
 *   magnitude  distance from the median in units of the tail band's distance, 1–3; a pause
 *              blocks every exit, so it is 3
 *   span       1 + (days the "since" reaches back, up to 2 years) / 2 years, 1–2
 */

import { bandEdge, WIRE_THRESHOLDS, type WireThresholds } from './detect'
import type {
  Anomaly,
  Bands,
  Impact,
  ImpactAxis,
  MetricKey,
  StateChange,
  Tail,
  WireStory,
} from './types'

const EFFECT: Record<MetricKey, Partial<Record<Tail, { axis: ImpactAxis; effect: string }>>> = {
  idleCashPct: { low: { axis: 'risk', effect: 'exit risk up' } },
  exitCapacity: { low: { axis: 'risk', effect: 'exit risk up' } },
  utilisationPct: { low: { axis: 'reward', effect: 'supply yield down' } },
  borrowAprPct: {
    high: { axis: 'reward', effect: 'borrow cost up' },
    low: { axis: 'reward', effect: 'borrow cost down' },
  },
  navDiscountBps: { high: { axis: 'risk', effect: 'collateral risk up' } },
  depegBps: { high: { axis: 'risk', effect: 'collateral risk up' } },
  oracleDeviationBps: { high: { axis: 'risk', effect: 'oracle risk up' } },
  priceMove24hPct: { low: { axis: 'risk', effect: 'collateral risk up' } },
}

export const AXIS_WEIGHT: Record<ImpactAxis, number> = { risk: 1, reward: 0.6 }
const SEVERITY_POINTS = { tail: 1, run: 1, extreme: 2, record: 3 } as const
const SPAN_CAP_DAYS = 730

const round2 = (x: number) => Math.round(x * 100) / 100
const spanPart = (days: number) => 1 + Math.min(Math.max(days, 0), SPAN_CAP_DAYS) / SPAN_CAP_DAYS

export function magnitudeOf(
  x: number,
  b: Bands,
  tail: Tail,
  th: WireThresholds = WIRE_THRESHOLDS,
): number {
  const unit = Math.abs(bandEdge(b, th.tailPct, tail) - b.p50)
  if (unit === 0) return 3
  return Math.min(3, Math.max(1, Math.abs(x - b.p50) / unit))
}

function score(
  axis: ImpactAxis,
  effect: string,
  severity: number,
  magnitude: number,
  span: number,
): Impact {
  const weight = AXIS_WEIGHT[axis]
  return {
    axis,
    effect,
    score: round2(weight * severity * magnitude * span),
    parts: { weight, severity, magnitude: round2(magnitude), span: round2(span) },
  }
}

export function levelImpact(a: Anomaly, th: WireThresholds = WIRE_THRESHOLDS): Impact {
  const e = EFFECT[a.baseline.metric][a.tail]
  if (!e) throw new Error(`venueWire: no effect for ${a.baseline.metric} ${a.tail}`)
  const x = a.baseline.guard[a.tail]
  return score(
    e.axis,
    e.effect,
    SEVERITY_POINTS[a.severity],
    magnitudeOf(x, a.baseline.bands, a.tail, th),
    spanPart(a.since.days),
  )
}

export function stateImpact(c: StateChange): Impact {
  if (!c.on)
    return score('risk', c.flag === 'frozen' ? 'venue reopened' : 'exits reopened', 1, 1, 1)
  const span = c.previous === null ? 2 : spanPart((c.at - c.previous) / 86_400)
  return c.flag === 'paused'
    ? score('risk', 'exits blocked', 7, 3, span)
    : score('risk', 'new deposits and borrows blocked', 3, 1, span)
}

/**
 * One story per subject and effect: the highest score keeps the headline and the others
 * fold into its `also` list (§3: say each fact once). Then sort by score, high first; ties
 * break on subject id, then metric, so the order is deterministic.
 */
export function rankStories(stories: WireStory[]): WireStory[] {
  const best = new Map<string, WireStory>()
  const folded = new Map<string, Set<MetricKey>>()
  for (const s of stories) {
    const key = `${s.subject.id}|${s.impact.effect}`
    const cur = best.get(key)
    if (!cur || s.impact.score > cur.impact.score) {
      if (cur && cur.metric !== 'state')
        (folded.get(key) ?? folded.set(key, new Set()).get(key)!).add(cur.metric)
      best.set(key, s)
    } else if (s.metric !== 'state')
      (folded.get(key) ?? folded.set(key, new Set()).get(key)!).add(s.metric)
  }
  const out = [...best.entries()].map(([key, s]) => {
    const also = [...(folded.get(key) ?? [])].filter((m) => m !== s.metric).sort()
    return also.length ? { ...s, also } : s
  })
  return out.sort(
    (a, b) =>
      b.impact.score - a.impact.score ||
      a.subject.id.localeCompare(b.subject.id) ||
      String(a.metric).localeCompare(String(b.metric)),
  )
}
