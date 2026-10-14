// build-touch-history.mjs — how often ETH and BTC moved L% or more within T days, as HISTORY.
//
// Writes lib/position/touchHistory.generated.json, the small aggregate the /position page
// reads (board rule N18: the hourly series stay in the private datasets repo; the app keeps
// only this table of integers).
//
// METHOD (stated on the page; keep the two in step):
//   origins   one per day, at 00:00 UTC, so the page can say "of days".
//   start S   the Chainlink oracle CLOSE of the hour ending at 00:00 (column `oracle`,
//             index i−1 where index i is the hour opening at 00:00).
//   fall      touched if the lowest hourly `oracleLow` over hours [i, i+T−1] is at or
//             below S·(1 − L).
//   rise      touched if the highest hourly `oracleHigh` over the same hours is at or
//             above S·(1 + L).
//   skipped   an origin whose S is null, whose window runs past the series end, or whose
//             window has more than 10% null hours (counted per direction's column).
//   coverage  origins and windows stay inside the file's own oracle-grade span
//             (`primary.segments` with source 'oracle'; ETH from 2020-04-08T21Z, BTC from
//             2020-01-01). A few earlier ETH oracle hours exist but are not oracle-grade.
//   levels    L = 1% … 60% in 1% steps. Horizons T = 1, 3, 7, 14, 30 days.
//   stored    per asset × direction × horizon: n origins, the first and last origin date,
//             and `touched[L−1]` = origins that touched L. Integers only.
//
// This is the Q26 rung-a convention (S_i = close[i−1]; window min of hourly LOW over
// [i, i+T−1]; touched if min ≤ S·(1−L)) restricted to daily origins.
//
// Run:  MEMBRANE_DATASETS_DIR=/path/to/membrane-datasets node scripts/position/build-touch-history.mjs

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { datasetPath, datasetsDir } from '../lib/datasetsDir.mjs'

export const HORIZONS = [
  { id: '1d', hours: 24 },
  { id: '3d', hours: 72 },
  { id: '7d', hours: 168 },
  { id: '14d', hours: 336 },
  { id: '30d', hours: 720 },
]
export const LEVEL_MIN = 1
export const LEVEL_MAX = 60
/** An origin is skipped when more than this share of its window's hours are null. */
export const MAX_NULL_SHARE = 0.1

const ASSETS = [
  { id: 'ETH', file: 'eth-usd-1h.json', feed: 'Chainlink ETH/USD' },
  { id: 'BTC', file: 'btc-usd-1h.json', feed: 'Chainlink BTC/USD' },
]

export const METHOD =
  'Daily origins at 00:00 UTC. Start = Chainlink oracle close of the hour ending 00:00. ' +
  'A fall of L touched if the lowest hourly oracle low in the next T hours is at or below ' +
  'start × (1 − L); a rise of L if the highest hourly oracle high is at or above start × (1 + L). ' +
  'Origins skipped when the start is missing or more than 10% of the window hours have no observation, ' +
  'and kept inside each file’s oracle-grade span. History, not a forecast.'

const isoDay = (ts) => new Date(ts * 1000).toISOString().slice(0, 10)

/**
 * The touch table for one series. Pure: arrays in, integers out.
 *
 * @param {{ startTs: number, stepSeconds: number, close: (number|null)[], low: (number|null)[], high: (number|null)[], span?: { fromIndex: number, toIndex: number } }} s
 *   `span` limits origins (and S at i−1) and their windows to [fromIndex, toIndex].
 * @returns {Record<'fall'|'rise', Record<string, { n: number, from: string|null, to: string|null, touched: number[] }>>}
 */
export function computeTouchTable(s) {
  const { startTs, stepSeconds, close, low, high } = s
  if (stepSeconds !== 3600) throw new Error(`expected an hourly grid, got stepSeconds ${stepSeconds}`)
  const count = close.length
  if (low.length !== count || high.length !== count) throw new Error('columns differ in length')
  const levels = LEVEL_MAX - LEVEL_MIN + 1
  const lo = s.span ? s.span.fromIndex : 0
  const hi = s.span ? s.span.toIndex : count - 1

  const out = { fall: {}, rise: {} }
  for (const h of HORIZONS) {
    for (const dir of ['fall', 'rise']) {
      const col = dir === 'fall' ? low : high
      const touched = new Array(levels).fill(0)
      let n = 0
      let from = null
      let to = null
      const maxNulls = Math.floor(h.hours * MAX_NULL_SHARE)
      for (let i = Math.max(1, lo + 1); i + h.hours - 1 <= hi; i++) {
        const ts = startTs + i * stepSeconds
        if (ts % 86400 !== 0) continue // daily origins at 00:00 UTC only
        const S = close[i - 1]
        if (S === null || S === undefined || !(S > 0)) continue
        let nulls = 0
        let ext = dir === 'fall' ? Infinity : -Infinity
        for (let k = i; k < i + h.hours; k++) {
          const v = col[k]
          if (v === null || v === undefined) {
            nulls++
            continue
          }
          if (dir === 'fall' ? v < ext : v > ext) ext = v
        }
        if (nulls > maxNulls || !Number.isFinite(ext)) continue
        n++
        if (from === null) from = isoDay(ts)
        to = isoDay(ts)
        for (let L = LEVEL_MIN; L <= LEVEL_MAX; L++) {
          // Integer-percent thresholds, compared as ext·100 against S·(100 ∓ L).
          const hit = dir === 'fall' ? ext * 100 <= S * (100 - L) : ext * 100 >= S * (100 + L)
          if (!hit) break // monotone in L: a level not touched means no deeper one was
          touched[L - LEVEL_MIN]++
        }
      }
      out[dir][h.id] = { n, from, to, touched }
    }
  }
  return out
}

/** sha256 of each file, asserted against the table in price-history/PROVENANCE.md. */
function provenanceHashes(dir) {
  const md = readFileSync(join(dir, 'PROVENANCE.md'), 'utf8')
  const out = {}
  for (const a of ASSETS) {
    const m = md.match(new RegExp('`' + a.file.replace('.', '\\.') + '`\\s*\\|\\s*\\d+\\s*\\|\\s*`([0-9a-f]{64})`'))
    if (!m) throw new Error(`PROVENANCE.md has no sha256 row for ${a.file}`)
    const actual = createHash('sha256').update(readFileSync(join(dir, a.file))).digest('hex')
    if (actual !== m[1]) {
      throw new Error(`${a.file}: sha256 ${actual} does not match PROVENANCE.md ${m[1]}`)
    }
    out[`price-history/${a.file}`] = actual
  }
  return out
}

/** The file's oracle-grade span: its single `primary` segment whose source is 'oracle'. */
function oracleSpan(j, file) {
  const segs = (j.primary?.segments ?? []).filter((g) => g.source === 'oracle')
  if (segs.length !== 1) {
    throw new Error(`${file}: expected one oracle primary segment, found ${segs.length}`)
  }
  return { fromIndex: segs[0].fromIndex, toIndex: segs[0].toIndex }
}

export function build(root = process.cwd()) {
  const base = datasetsDir(root)
  const dir = datasetPath(root, 'price-history')
  const sha256 = provenanceHashes(dir)
  let commit = null
  try {
    commit = execFileSync('git', ['-C', base, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    throw new Error(`could not read the datasets commit (git -C ${base} rev-parse HEAD)`)
  }

  const assets = {}
  for (const a of ASSETS) {
    const j = JSON.parse(readFileSync(join(dir, a.file), 'utf8'))
    const { oracle, oracleLow, oracleHigh } = j.columns
    if (!oracle || !oracleLow || !oracleHigh) throw new Error(`${a.file}: missing an oracle column`)
    const span = oracleSpan(j, a.file)
    const table = computeTouchTable({
      span,
      startTs: j.startTs,
      stepSeconds: j.stepSeconds,
      close: oracle,
      low: oracleLow,
      high: oracleHigh,
    })
    assets[a.id] = {
      feed: a.feed,
      oracleGradeFrom: new Date((j.startTs + span.fromIndex * j.stepSeconds) * 1000).toISOString(),
      ...table,
    }
  }

  return {
    schema: 1,
    method: METHOD,
    levels: { min: LEVEL_MIN, max: LEVEL_MAX, step: 1 },
    horizons: HORIZONS,
    maxNullShare: MAX_NULL_SHARE,
    source: {
      repo: 'triccs/membrane-datasets',
      commit,
      paths: Object.keys(sha256),
      sha256,
      columns: { start: 'oracle', fall: 'oracleLow', rise: 'oracleHigh' },
    },
    generatedAt: new Date().toISOString(),
    assets,
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) {
  const here = dirname(fileURLToPath(import.meta.url))
  const repo = resolve(here, '..', '..')
  const outPath = join(repo, 'lib', 'position', 'touchHistory.generated.json')
  const table = build(repo)
  // One line per horizon row keeps the diff readable and the file small.
  const json = JSON.stringify(table, null, 1).replace(/\[\s*([\d,\s]+?)\s*\]/g, (_m, inner) => `[${inner.replace(/\s+/g, '')}]`)
  writeFileSync(outPath, json + '\n')
  const eth = table.assets.ETH.fall['7d']
  const pct = (L) => ((eth.touched[L - 1] / eth.n) * 100).toFixed(1)
  console.log(
    `wrote ${outPath} · ETH 7d falls: 10% ${pct(10)}% · 20% ${pct(20)}% · 30% ${pct(30)}% · n ${eth.n} · ${eth.from} → ${eth.to}`,
  )
}
