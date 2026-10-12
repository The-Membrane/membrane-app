/**
 * stress-cash-scale-test — does a venue's stress exit capacity scale with the venue's size
 * (a SHARE of supply, f) or stay an ABSOLUTE amount of cash? The answer decides whether a
 * stress level is quoted as historical cash or as f × the supply now.
 *
 * Run (from the repo root):
 *   ./node_modules/.bin/tsx scripts/position-sim/stress-cash-scale-test.ts
 * Reads public/data/venue-stress/{history,summary}.json. No chain reads.
 *
 * UNIT: the engine's stress events (lib/position-sim/stressEventCash.ts): per event, C = the
 * lowest held idle cash over the 8 h from onset, S = the supply at that onset, f8 = the
 * lowest held f. Token units (WETH in ETH).
 *
 * PRE-REGISTERED (written before the first run, 2026-10-12):
 *  T1 ELASTICITY. log C = a_venue + β log S, venue fixed effects, events with f8 > 1% (a
 *     locked event has no cash to scale). 95% CI by bootstrap of events within each venue
 *     (2,000 draws, seed 1). CI contains 1 and excludes 0 → PROPORTIONAL. Contains 0 and
 *     excludes 1 → ABSOLUTE. Otherwise MIXED (report β).
 *  T2 OUT OF SAMPLE. Per venue, events in onset order split at the middle (earlier half
 *     trains, later half tests; ≥ 3 events each). For typical (p50) and bad (p10), nearest
 *     rank as the engine: ABSOLUTE predicts the later level of C as the earlier level of C;
 *     PROPORTIONAL as the earlier level of f8 × the later half's median S. Error |ln(pred /
 *     actual)|. A cell whose actual event is locked (f8 ≤ 1%) is reported, not scored: zero
 *     cash is zero under both. A model wins if its mean error is lower AND it wins ≥ 2/3 of
 *     the scored cells. Else INCONCLUSIVE.
 */
import fs from 'node:fs'
import path from 'node:path'

import {
  eventLevel,
  stressEventCash,
  type StressEventCash,
  type StressEventLevel,
} from '../../lib/position-sim/stressEventCash'
import {
  VENUE_DEFAULT_STRESS_UTIL,
  VENUE_LOCK_F,
  stressWindowsFromEpisodes,
  utilWindowsFromSeries,
  venueSeriesFromHistory,
  type VenueStressEpisode,
  type VenueStressHistoryFile,
} from '../../lib/position-sim/venueStressAnalogs'

const ROOT = path.resolve(__dirname, '../..')
const readJson = <T>(rel: string): T =>
  JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')) as T

const history = readJson<VenueStressHistoryFile>('public/data/venue-stress/history.json')
const summary = readJson<{
  method: { minSize: Record<string, number>; stressUtil: Record<string, number> }
  episodes: VenueStressEpisode[]
}>('public/data/venue-stress/summary.json')

const series = venueSeriesFromHistory(history, { minSize: summary.method.minSize })
const derivedUtil = series
  .filter((s) => summary.method.stressUtil[s.venue] === undefined)
  .flatMap((s) => utilWindowsFromSeries(s, VENUE_DEFAULT_STRESS_UTIL))
const windows = stressWindowsFromEpisodes(summary.episodes, derivedUtil)

const byVenue = series.map((s) => ({ s, events: stressEventCash(s, windows) }))

// ------------------------------------------------------------------ T1

function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Pt = { x: number; y: number }
/** Within-venue slope of y on x (fixed effects): Σ dx·dy / Σ dx². */
function feSlope(groups: readonly Pt[][]): number {
  let sxy = 0
  let sxx = 0
  for (const g of groups) {
    if (g.length < 2) continue
    const mx = g.reduce((a, p) => a + p.x, 0) / g.length
    const my = g.reduce((a, p) => a + p.y, 0) / g.length
    for (const p of g) {
      sxy += (p.x - mx) * (p.y - my)
      sxx += (p.x - mx) ** 2
    }
  }
  return sxy / sxx
}

const live = (e: StressEventCash) => e.f8 > VENUE_LOCK_F && e.cash8 > 0
const groups: Pt[][] = byVenue.map(({ events }) =>
  events.filter(live).map((e) => ({ x: Math.log(e.supply), y: Math.log(e.cash8) })),
)
const beta = feSlope(groups)
const rnd = mulberry32(1)
const draws: number[] = []
for (let b = 0; b < 2000; b++) {
  draws.push(feSlope(groups.map((g) => g.map(() => g[Math.floor(rnd() * g.length)]))))
}
draws.sort((a, b) => a - b)
const lo = draws[Math.floor(0.025 * draws.length)]
const hi = draws[Math.floor(0.975 * draws.length) - 1]
const t1 =
  lo <= 1 && hi >= 1 && lo > 0
    ? 'PROPORTIONAL'
    : lo <= 0 && hi >= 0 && hi < 1
      ? 'ABSOLUTE'
      : 'MIXED'

console.log('T1 elasticity of stress cash to venue supply (venue fixed effects, f8 > 1%)')
for (const { s, events } of byVenue) {
  const ev = events.filter(live)
  const sup = ev.map((e) => e.supply)
  const range = sup.length ? Math.max(...sup) / Math.min(...sup) : NaN
  const b = feSlope([ev.map((e) => ({ x: Math.log(e.supply), y: Math.log(e.cash8) }))])
  console.log(
    `  ${s.name.padEnd(16)} events ${String(events.length).padStart(3)} (unlocked ${String(ev.length).padStart(3)})` +
      `  supply range ×${range.toFixed(1).padStart(5)}  β ${Number.isFinite(b) ? b.toFixed(2) : '—'}`,
  )
}
console.log(
  `  pooled β = ${beta.toFixed(3)}  95% CI [${lo.toFixed(3)}, ${hi.toFixed(3)}]  → ${t1}\n`,
)

// ------------------------------------------------------------------ T2

const LEVELS: StressEventLevel[] = ['typical', 'bad']
const cells: { venue: string; level: string; abs: number; prop: number }[] = []
const locked: string[] = []
console.log('T2 out of sample: earlier half predicts the later half')
for (const { s, events } of byVenue) {
  const k = Math.floor(events.length / 2)
  const train = events.slice(0, k)
  const test = events.slice(k)
  if (train.length < 3 || test.length < 3) {
    console.log(`  ${s.name.padEnd(16)} too few events (${events.length})`)
    continue
  }
  const sTest = test.map((e) => e.supply).sort((a, b) => a - b)[Math.floor((test.length - 1) / 2)]
  for (const level of LEVELS) {
    const actualEv = eventLevel(test, level, (e) => e.cash8)!
    const absPred = eventLevel(train, level, (e) => e.cash8)!.cash8
    const propPred = eventLevel(train, level, (e) => e.f8)!.f8 * sTest
    const tag = `${s.name.padEnd(16)} ${level.padEnd(7)}`
    if (actualEv.f8 <= VENUE_LOCK_F) {
      locked.push(`${s.name} ${level}`)
      console.log(`  ${tag} actual locked (${actualEv.name}): not scored`)
      continue
    }
    const err = (p: number) => Math.abs(Math.log(Math.max(p, 1e-9) / actualEv.cash8))
    const c = { venue: s.name, level, abs: err(absPred), prop: err(propPred) }
    cells.push(c)
    const fmt = (x: number) => (x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : x.toFixed(0)).padStart(8)
    console.log(
      `  ${tag} actual ${fmt(actualEv.cash8)}  abs ${fmt(absPred)} (err ${c.abs.toFixed(2)})` +
        `  prop ${fmt(propPred)} (err ${c.prop.toFixed(2)})  ${c.prop < c.abs ? 'prop' : 'abs'}`,
    )
  }
}
const mean = (k: 'abs' | 'prop') => cells.reduce((a, c) => a + c[k], 0) / cells.length
const propWins = cells.filter((c) => c.prop < c.abs).length
const absWins = cells.length - propWins
const t2 =
  mean('prop') < mean('abs') && propWins >= (2 / 3) * cells.length
    ? 'PROPORTIONAL'
    : mean('abs') < mean('prop') && absWins >= (2 / 3) * cells.length
      ? 'ABSOLUTE'
      : 'INCONCLUSIVE'
console.log(
  `  scored cells ${cells.length} (locked, not scored: ${locked.length})` +
    `  mean |ln err|: abs ${mean('abs').toFixed(3)}, prop ${mean('prop').toFixed(3)}` +
    `  wins: prop ${propWins}, abs ${absWins}  → ${t2}`,
)
