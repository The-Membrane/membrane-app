// build-touch-time.mjs — the /position time-to-touch grid: the SAME forecast as
// touchHistory.generated.json (build-touch-history.mjs), read at more window lengths, so the
// page can draw "chance the line is touched by time t" from 1 hour to 7 days as one curve.
//
// SAME MODEL, MORE HORIZONS. Origins, start price, outcome, rows, split, levels and the
// band scheme are build-touch-history.mjs's own functions (outcomes, touchedCounts,
// blockDraw, bandFromDraw), called with T = h / 24 days for every h in GRID_HOURS. Nothing
// is fitted. At 24, 72 and 168 hours the rows are exactly the table's 1d / 3d / 7d rows (the
// test asserts the counts match), so the curve passes through the figures the page quotes.
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
  LEVEL_MAX,
  LEVEL_MIN,
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

export const TIME_METHOD =
  'The forecast table’s own outcome (daily 00:00 UTC origins from 2021-03-25, start = oracle close of the hour ending at the origin, a fall of L touches when the lowest hourly oracle low in the window is at or below start × (1 − L)), counted for windows of 1 hour to 7 days. ' +
  'Hourly data: 1 hour is the shortest window it resolves. Band: 90% moving-block bootstrap (blocks of max(30, 2T) days, 2000 replicates, seed 20261013), top floored at 3·max(1, T) touches. ' +
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
        const floor = Math.min(n, Math.ceil(3 * Math.max(1, days)))
        assets[a.id][dir][String(h)] = {
          n,
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
