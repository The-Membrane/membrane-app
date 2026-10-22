// build-touch-time.mjs — the /position time-to-touch grid: the SAME forecast as
// touchHistory.generated.json (build-touch-history.mjs), read at more window lengths, so the
// page can draw "chance the line is touched by time t" from 1 hour to 7 days as one curve.
//
// SAME MODEL, MORE HORIZONS. Start price, outcome, split, levels and the band scheme are
// build-touch-history.mjs's own. Nothing is fitted.
//   1 day and longer: its own functions (outcomes, touchedCounts, blockDraw, bandFromDraw),
//     daily 00:00 UTC origins, called with T = h / 24 days. At 24, 72 and 168 hours the rows
//     are exactly the table's 1d / 3d / 7d rows (the test asserts the counts match).
//   Under a day: EVERY hour is an origin (24 a day), not just 00:00 UTC. The hour of day
//     matters at short windows (an ETH 1% fall within 1 h: about 10% of 00 UTC origins,
//     about 19% of 14 UTC ones), so one fixed origin hour would misstate them. Overlapping
//     origins are not independent: the band resamples whole days (each day's 24 origins
//     together) in blocks of 30 days that never span the 2024-01-01 seam, and the top is
//     floored at the rule of three on the n·1h/T non-overlapping windows: 3·T_hours of n.
//
// WHAT IS NOT CHECKED. validation/t1 scores T = 1, 3, 7, 14 and 30 days only. Every other
// grid length has no realized-outcome check behind it: the page draws those points as
// model-only (a lighter band) and quotes no confidence for them.
//
// RESOLUTION. The series is hourly (oracle lows/highs per hour), so 1 hour is the shortest
// window this history can resolve; nothing under an hour is built.
//
// BAND. One block draw per grid length (blocks of max(30, 2T) origin days never spanning the
// 2024-01-01 seam), 2000 replicates, seed 20261013 — a seed of its own, so the table's
// draws are untouched. The band top is floored at the rule of three on independent
// windows: 3·max(1, T) touches of n (daily origins: windows shorter than a day never
// overlap, so all n are independent and the floor is 3/n).
//
// Run:  MEMBRANE_DATASETS_DIR=/path/to/membrane-datasets node scripts/position/build-touch-time.mjs

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { datasetPath, datasetsDir } from '../lib/datasetsDir.mjs'
import {
  BOOTSTRAP,
  CALIB_START,
  LEVEL_MAX,
  LEVEL_MIN,
  SPLIT,
  T1_END,
  bandFromDraw,
  blockDraw,
  makeRng,
  outcomes,
  touchedCounts,
  verified,
} from './build-touch-history.mjs'

/** Window lengths in hours. 24 / 72 / 168 coincide with the table's checked 1d / 3d / 7d. */
export const GRID_HOURS = [1, 2, 3, 4, 6, 8, 12, 18, 24, 36, 48, 60, 72, 96, 120, 144, 168]
/** Grid lengths validation/t1 scores (in hours): the only ones with a realized-outcome check. */
export const CHECKED_HOURS = [24, 72, 168]
export const TIME_SEED = 20261013
const HOUR = 3600
const DAY = 86400

/**
 * Every-hour origins for a window of `hours`: build-touch-history's outcome with origins
 * stepping one hour. Rows carry the origin's UTC day for the day-block bootstrap.
 */
export function hourlyOutcomes(series, hours, window = { from: CALIB_START, split: SPLIT, end: T1_END }) {
  const { startTs, close, low } = series
  const idx = (ts) => (ts - startTs) / HOUR
  const rows = []
  for (let t0 = window.from; t0 + hours * HOUR <= window.end; t0 += HOUR) {
    const end = t0 + hours * HOUR
    const split = t0 < window.split ? (end <= window.split ? 'calib' : null) : 'test'
    if (!split) continue
    const S = close[idx(t0 - HOUR)]
    if (S === null || S === undefined || !(S > 0)) continue
    let lo = Infinity
    let hi = -Infinity
    let gap = false
    for (let j = idx(t0); j <= idx(end - HOUR); j++) {
      const a = low[j]
      const b = series.high[j]
      if (a === null || a === undefined || b === null || b === undefined) {
        gap = true
        break
      }
      if (a < lo) lo = a
      if (b > hi) hi = b
    }
    if (gap) continue
    let fall = 0
    for (let L = LEVEL_MIN; L <= LEVEL_MAX; L++) {
      if (lo <= S * (1 + -L / 100)) fall = L
      else break
    }
    let rise = 0
    for (let L = LEVEL_MIN; L <= LEVEL_MAX; L++) {
      if (hi >= S * (1 + L / 100)) rise = L
      else break
    }
    rows.push({ t0, day: Math.floor(t0 / DAY), split, fall, rise })
  }
  return rows
}

/**
 * The day-block bootstrap for every-hour rows: whole days (all their origins) resampled in
 * blocks of `blockDays` consecutive days, never across the seam (the first test day).
 * Returns the 90% band of touch counts per level, scaled to the rows' n.
 */
export function dayBlockBand(rng, rows, dir, blockDays = BOOTSTRAP.minBlockDays, replicates = BOOTSTRAP.replicates) {
  const days = []
  const byDay = new Map()
  for (const r of rows) {
    let d = byDay.get(r.day)
    if (!d) {
      d = { day: r.day, test: r.split === 'test', n: 0, hist: new Int32Array(LEVEL_MAX + 1) }
      byDay.set(r.day, d)
      days.push(d)
    }
    d.n++
    d.hist[r[dir]]++
  }
  // Per day, touched[L] = origins whose deepest level ≥ L.
  const cum = days.map((d) => {
    const out = new Int32Array(LEVEL_MAX)
    let acc = 0
    for (let L = LEVEL_MAX; L >= LEVEL_MIN; L--) {
      acc += d.hist[L]
      out[L - 1] = acc
    }
    return out
  })
  const N = days.length
  const seam = days.findIndex((d) => d.test)
  const valid = []
  for (let i = 0; i + blockDays <= N; i++) if (!(seam > 0 && i < seam && seam < i + blockDays)) valid.push(i)
  const nb = Math.ceil(N / blockDays)
  const per = Array.from({ length: LEVEL_MAX }, () => new Float64Array(replicates))
  const sum = new Float64Array(LEVEL_MAX)
  for (let r = 0; r < replicates; r++) {
    sum.fill(0)
    let taken = 0
    let nRows = 0
    for (let k = 0; k < nb; k++) {
      const s = valid[rng.int(valid.length)]
      for (let j = 0; j < blockDays && taken < N; j++, taken++) {
        const c = cum[s + j]
        nRows += days[s + j].n
        for (let L = 0; L < LEVEL_MAX; L++) sum[L] += c[L]
      }
    }
    // A replicate's share, scaled to the real n (days carry different origin counts).
    for (let L = 0; L < LEVEL_MAX; L++) per[L][r] = (sum[L] / nRows) * rows.length
  }
  const qLo = (1 - BOOTSTRAP.band) / 2
  const lo = []
  const hi = []
  for (const arr of per) {
    const s = Array.from(arr).sort((x, y) => x - y)
    lo.push(Math.floor(s[Math.floor(qLo * (replicates - 1))]))
    hi.push(Math.ceil(s[Math.ceil((1 - qLo) * (replicates - 1) - 1e-9)]))
  }
  return { lo, hi }
}

export const TIME_METHOD =
  'The forecast table’s own outcome (start = oracle close of the hour ending at the origin, a fall of L touches when the lowest hourly oracle low in the window is at or below start × (1 − L)), counted for windows of 1 hour to 7 days from 2021-03-25. ' +
  'Windows of a day or more: daily 00:00 UTC origins, as the table. Windows under a day: every hour is an origin (24 a day), since the hour of day matters at short windows. ' +
  'Hourly data: 1 hour is the shortest window it resolves. Band: 90% bootstrap, 2000 replicates, seed 20261013; daily origins in moving blocks of max(30, 2T) days, hourly origins as whole days in 30-day blocks; top floored at the rule of three on non-overlapping windows (3T touches, T in days, or 3·hours for hourly origins). ' +
  'validation/t1 scores 1, 3 and 7 days only: every other window is model-only, with no realized-outcome check.'

const ASSETS = [
  { id: 'ETH', file: 'eth-usd-1h.json' },
  { id: 'BTC', file: 'btc-usd-1h.json' },
]

export function build(root = process.cwd()) {
  const base = datasetsDir(root)
  const ph = datasetPath(root, 'price-history')
  const commit = execFileSync('git', ['-C', base, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const series = {}
  const sha256 = {}
  for (const a of ASSETS) {
    const { buf, sha256: s } = verified(ph, a.file)
    sha256[`price-history/${a.file}`] = s
    const j = JSON.parse(buf.toString('utf8'))
    if (j.stepSeconds !== HOUR) throw new Error(`${a.file}: not hourly`)
    if (j.startTs + j.count * HOUR !== T1_END) throw new Error(`${a.file}: series does not end where t1 does`)
    series[a.id] = { startTs: j.startTs, close: j.columns.oracle, low: j.columns.oracleLow, high: j.columns.oracleHigh }
  }

  const rng = makeRng(TIME_SEED)
  const assets = { ETH: { fall: {}, rise: {} }, BTC: { fall: {}, rise: {} } }
  for (const h of GRID_HOURS) {
    const days = h / 24
    if (h < 24) {
      // Every hour an origin; the day-block band.
      const rows = { ETH: hourlyOutcomes(series.ETH, h), BTC: hourlyOutcomes(series.BTC, h) }
      for (const a of ASSETS) {
        for (const dir of ['fall', 'rise']) {
          const r = rows[a.id]
          const n = r.length
          const band = dayBlockBand(rng, r, dir)
          const floor = Math.min(n, Math.ceil(3 * h))
          assets[a.id][dir][String(h)] = {
            n,
            origins: 'hourly',
            touched: touchedCounts(r.map((x) => x[dir])),
            lo: band.lo,
            hi: band.hi.map((x) => Math.max(x, floor)),
          }
        }
      }
      continue
    }
    const rows = { ETH: outcomes(series.ETH, days), BTC: outcomes(series.BTC, days) }
    if (rows.ETH.map((r) => r.t0).join() !== rows.BTC.map((r) => r.t0).join()) {
      throw new Error(`ETH and BTC origin days differ at ${h}h`)
    }
    const seam = rows.ETH.findIndex((r) => r.split === 'test')
    const draw = blockDraw(rng, rows.ETH.length, days, BOOTSTRAP.replicates, seam > 0 ? [seam] : [])
    for (const a of ASSETS) {
      for (const dir of ['fall', 'rise']) {
        const deepest = rows[a.id].map((r) => r[dir])
        const n = deepest.length
        const band = bandFromDraw(draw, deepest)
        const floor = Math.min(n, Math.ceil(3 * days))
        assets[a.id][dir][String(h)] = {
          n,
          origins: 'daily',
          touched: touchedCounts(deepest),
          lo: band.lo,
          hi: band.hi.map((x) => Math.max(x, floor)),
        }
      }
    }
  }
  return {
    schema: 1,
    method: TIME_METHOD,
    levels: { min: LEVEL_MIN, max: LEVEL_MAX, step: 1 },
    hours: GRID_HOURS,
    checkedHours: CHECKED_HOURS,
    bootstrap: { replicates: BOOTSTRAP.replicates, seed: TIME_SEED, band: BOOTSTRAP.band },
    source: { repo: 'triccs/membrane-datasets', commit, sha256 },
    generatedAt: new Date().toISOString(),
    assets,
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) {
  const here = dirname(fileURLToPath(import.meta.url))
  const repo = resolve(here, '..', '..')
  const outPath = join(repo, 'lib', 'position', 'touchTime.generated.json')
  const grid = build(repo)
  const json = JSON.stringify(grid, null, 1).replace(/\[\s*([\d,\s]+?)\s*\]/g, (_m, inner) => `[${inner.replace(/\s+/g, '')}]`)
  writeFileSync(outPath, json + '\n')
  const e = grid.assets.ETH.fall
  for (const L of [5, 10, 14, 20]) {
    console.log(`ETH fall ${L}%: ` + GRID_HOURS.map((h) => `${h}h ${((e[h].touched[L - 1] / e[h].n) * 100).toFixed(1)}`).join(' · '))
  }
  console.log(`wrote ${outPath}`)
}
