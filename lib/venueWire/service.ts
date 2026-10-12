/**
 * The Wire, assembled: frames → detection → templated stories → ranked response. Pure; the
 * API route reads the files (lib/venueWire/load.ts) and passes them in.
 */

import { detect, seriesKey, WIRE_THRESHOLDS, type Detection, type WireThresholds } from './detect'
import { levelImpact, rankStories, stateImpact } from './rank'
import { buildFrames, type WireFrames, type WireInputs } from './series'
import { anomalyHeadline, anomalyLabels, stateHeadline, stateLabels } from './templates'
import type { Baseline, Uncovered, WireStory } from './types'

export const WIRE_SCHEMA = 'venue-wire/v1'

export interface InputAge {
  name: string
  lastTs: number | null
  ageHours: number | null
  stale: boolean
}

export interface WireResponse {
  schema: typeof WIRE_SCHEMA
  /** Evaluation time (unix s): the newest venue reading unless the query set one. */
  asOf: number
  /** Any input older than the stale limit at request time: hatch the page, suppress headlines (§4). */
  stale: boolean
  inputs: InputAge[]
  thresholds: WireThresholds
  total: number
  stories: WireStory[]
  /** Series that gave no verdict, and why. A quiet wire is not an all-clear. */
  uncovered: Uncovered[]
}

export interface BaselinesResponse {
  schema: typeof WIRE_SCHEMA
  asOf: number
  stale: boolean
  inputs: InputAge[]
  baselines: Baseline[]
  uncovered: Uncovered[]
}

export interface WireQuery {
  view: 'stories' | 'baselines'
  asOf?: number
  venue?: string
  limit: number
}

export class QueryError extends Error {}

const LIMIT_DEFAULT = 20
const LIMIT_MAX = 100

/** Query → WireQuery. Throws QueryError on bad input (the route answers 400). */
export function parseWireQuery(q: Record<string, string | string[] | undefined>): WireQuery {
  const one = (k: string) => {
    const v = q[k]
    if (Array.isArray(v)) throw new QueryError(`${k} given more than once`)
    return v
  }
  const rawView = one('view')
  if (rawView !== 'wire' && rawView !== 'baselines')
    throw new QueryError('view must be wire or baselines')
  const view = rawView === 'baselines' ? 'baselines' : 'stories'
  let asOf: number | undefined
  const rawAsOf = one('asOf')
  if (rawAsOf !== undefined) {
    const n = /^\d+$/.test(rawAsOf) ? Number(rawAsOf) : Date.parse(rawAsOf) / 1000
    if (!Number.isFinite(n) || n <= 0)
      throw new QueryError('asOf must be unix seconds or an ISO date')
    asOf = Math.floor(n)
  }
  const venue = one('venue')
  if (venue !== undefined && !/^[a-z0-9-]{1,64}$/.test(venue))
    throw new QueryError('venue must be a venue or asset id')
  let limit = LIMIT_DEFAULT
  const rawLimit = one('limit')
  if (rawLimit !== undefined) {
    if (!/^\d+$/.test(rawLimit)) throw new QueryError('limit must be a whole number')
    limit = Math.min(LIMIT_MAX, Math.max(1, Number(rawLimit)))
  }
  return { view, asOf, venue, limit }
}

const hourIso = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 13) + 'Z'

/**
 * Findings → stories, unranked. A story is stale when the newest reading of its input is
 * older than the stale limit at `now`: the client hatches it and suppresses its headline (§4).
 */
export function storiesOf(
  det: Detection,
  frames: WireFrames,
  now: number,
  th: WireThresholds,
): WireStory[] {
  const staleS = th.staleHours * 3600
  const stale = (subject: string, metric: string) => {
    const t = det.newest.get(seriesKey(subject, metric))
    return t === undefined || now - t > staleS
  }
  return det.findings.map((f): WireStory => {
    if (f.kind === 'state') {
      return {
        id: `${f.subject.id}:state:${f.flag}:${f.on ? 'on' : 'off'}:${hourIso(f.at)}`,
        subject: f.subject,
        metric: 'state',
        tail: f.on ? 'on' : 'off',
        severity: 'state',
        headline: stateHeadline(f),
        labels: stateLabels(f),
        value: null,
        unit: f.flag,
        since: {
          ts: f.on ? f.previous : f.runFrom,
          days:
            (f.on ? f.at - (f.previous ?? f.recordFromTs) : f.at - (f.runFrom ?? f.at)) / 86_400,
        },
        bands: null,
        impact: stateImpact(f),
        affects: [f.subject.id],
        also: [],
        at: f.at,
        source: f.source,
        stale: stale(f.subject.id, 'state'),
      }
    }
    const b = f.baseline
    const asset = frames.assets.get(b.subject.id)
    return {
      id: `${b.subject.id}:${b.metric}:${f.kind}:${f.tail}:${hourIso(b.at)}`,
      subject: b.subject,
      metric: b.metric,
      tail: f.tail,
      severity: f.severity,
      headline: anomalyHeadline(f),
      labels: anomalyLabels(f, frames),
      value: b.guard[f.tail],
      unit: b.unit,
      since: f.since,
      bands: b.bands,
      impact: levelImpact(f, th),
      // Only venues that held material size at the story's time.
      affects:
        b.subject.kind === 'venue'
          ? [b.subject.id]
          : (asset?.affects ?? []).filter(
              (id) => (frames.venues.get(id)?.fromTs ?? Infinity) <= b.at,
            ),
      also: [],
      at: b.at,
      source: b.source,
      stale: stale(b.subject.id, b.metric),
    }
  })
}

/** Newest reading of each input. */
export function inputAges(frames: WireFrames, now: number, th: WireThresholds): InputAge[] {
  const out: InputAge[] = []
  const add = (name: string, t: number[]) => {
    const last = t.length ? t[t.length - 1] : null
    const ageHours = last === null ? null : Math.round(((now - last) / 3600) * 10) / 10
    out.push({ name, lastTs: last, ageHours, stale: ageHours === null || ageHours > th.staleHours })
  }
  const anyVenue = frames.venues.values().next().value
  if (anyVenue) add('venue-stress', anyVenue.t)
  for (const a of frames.assets.values()) add(`price:${a.subject.id}`, a.t)
  return out
}

/** Default evaluation time: the newest venue reading, else the newest reading of any input. */
export function defaultAsOf(frames: WireFrames): number | null {
  const anyVenue = frames.venues.values().next().value
  if (anyVenue?.t.length) return anyVenue.t[anyVenue.t.length - 1]
  let best: number | null = null
  for (const a of frames.assets.values())
    if (a.t.length) best = Math.max(best ?? 0, a.t[a.t.length - 1])
  return best
}

export interface BuildOptions {
  now?: number
  thresholds?: WireThresholds
}

const relevant = (s: WireStory, venue?: string) =>
  !venue || s.subject.id === venue || s.affects.includes(venue)

export function buildWire(
  src: WireInputs | WireFrames,
  q: WireQuery,
  opts: BuildOptions = {},
): WireResponse | BaselinesResponse {
  const frames = 'series' in src ? src : buildFrames(src)
  const th = opts.thresholds ?? WIRE_THRESHOLDS
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  const inputs = inputAges(frames, now, th)
  const stale = inputs.length === 0 || inputs.some((i) => i.stale)
  const asOf = q.asOf ?? defaultAsOf(frames) ?? now
  const det = detect(frames, asOf, th)
  const keep = (id: string) =>
    !q.venue || id === q.venue || frames.assets.get(id)?.affects.includes(q.venue)
  const uncovered: Uncovered[] = [
    ...frames.missing.map(
      (name): Uncovered => ({
        subject: name,
        metric: 'all',
        reason: 'input-missing',
        detail: 'input file not found in the datasets repo (board rule N18)',
      }),
    ),
    ...det.uncovered.filter((u) => keep(u.subject)),
  ]
  if (q.view === 'baselines')
    return {
      schema: WIRE_SCHEMA,
      asOf,
      stale,
      inputs,
      baselines: det.baselines.filter((b) => keep(b.subject.id)),
      uncovered,
    }
  const ranked = rankStories(storiesOf(det, frames, now, th)).filter((s) => relevant(s, q.venue))
  return {
    schema: WIRE_SCHEMA,
    asOf,
    stale,
    inputs,
    thresholds: th,
    total: ranked.length,
    stories: ranked.slice(0, q.limit),
    uncovered,
  }
}
