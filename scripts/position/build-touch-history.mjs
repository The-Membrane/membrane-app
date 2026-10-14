// build-touch-history.mjs — the /position forecast table: how often ETH and BTC touched a
// line L% away within T days, per the validation/t1 outcome definition, with a 90% block-
// bootstrap band per cell and a preliminary confidence label per asset × horizon.
//
// Writes lib/position/touchHistory.generated.json, the small aggregate the page reads
// (board rule N18: the hourly series stay in the private datasets repo; the app keeps only
// this table of integers).
//
// OUTCOME — mirrors membrane-datasets validation/t1 EXACTLY (t1_touch.py, results.json
// `decisions`), and the build asserts it row by row against t1's forecasts-*.csv.gz:
//   origin t0  each UTC day 00:00.
//   start S    oracle close of the hour opening at t0 − 1h (column `oracle`).
//   window     hours opening in [t0, t0 + T·86400 − 3600]; any null in the window → no row.
//   fall       y = 1 iff min(oracleLow over the window) ≤ S·(1 + k), k = −L/100.
//   rise       y = 1 iff max(oracleHigh over the window) ≥ S·(1 + k), k = +L/100 (not in t1;
//              same origins and window, for positions whose debt is the volatile asset).
//   rows       t1's split: calib iff t0 ≥ 2021-03-25 and t0 + T ≤ 2024-01-01; test iff
//              t0 ≥ 2024-01-01 and t0 + T ≤ 2026-10-06T03Z (the series end). Origins whose
//              window straddles 2024-01-01 are purged, as in t1. The forecast uses calib ∪ test.
//   levels     L = 1% … 60% in 1% steps. Horizons T = 1, 3, 7, 14, 30 days.
//
// BAND — t1's bootstrap scheme: moving blocks of b = max(30, 2T) consecutive origin days,
// ⌈N/b⌉ blocks per replicate, starts uniform on [0, N − b], concatenated and cut to N days;
// 2000 replicates, seed 20261012, ONE draw per horizon shared by both assets, both
// directions and every level. The PRNG is xoshiro128** (numpy's PCG64 stream is not
// reproduced). The 90% band is the 5th / 95th percentile of the replicate touch counts by
// nearest rank, widened outward (lower index floored, upper ceiled), so it is integers.
//
// CONFIDENCE (preliminary; a new kind of number awaiting owner approval; Q26 labels will
// replace it): per asset × direction × horizon, a CHECK is one t1 level (5, 10, 15, 20,
// 30%) with ≥ 1 touch in either span. It HOLDS when the test-span (2024–26) frequency lies
// inside the 90% band built from calib-span (2021–23) rows only. Label: high if every check
// holds and there are ≥ 4; medium if at least half hold; low otherwise; untested if there
// are no checks.
//
// Run:  MEMBRANE_DATASETS_DIR=/path/to/membrane-datasets node scripts/position/build-touch-history.mjs

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'

import { datasetPath, datasetsDir } from '../lib/datasetsDir.mjs'

export const HORIZONS = [
  { id: '1d', days: 1 },
  { id: '3d', days: 3 },
  { id: '7d', days: 7 },
  { id: '14d', days: 14 },
  { id: '30d', days: 30 },
]
export const LEVEL_MIN = 1
export const LEVEL_MAX = 60

const DAY = 86400
const HOUR = 3600
/** t1's split boundaries (results.json decisions; t1_parent.py CS / SP / TE). */
export const CALIB_START = Date.UTC(2021, 2, 25) / 1000 // 2021-03-25T00Z
export const SPLIT = Date.UTC(2024, 0, 1) / 1000 // 2024-01-01T00Z
export const T1_END = Date.UTC(2026, 9, 6, 3) / 1000 // 2026-10-06T03Z

/** t1's levels, the only ones the cross-check and the confidence checks use. */
export const T1_LEVELS = [5, 10, 15, 20, 30]

export const BOOTSTRAP = { replicates: 2000, seed: 20261012, band: 0.9, minBlockDays: 30, blockPerHorizonDays: 2 }

/** The preliminary label rule. Swappable: the page reads only `label`, `held`, `checks`. */
export const CONFIDENCE_RULE = { highMinChecks: 4, mediumMinShare: 0.5 }

export function confidenceLabel(held, checks) {
  if (checks === 0) return 'untested'
  if (held === checks && checks >= CONFIDENCE_RULE.highMinChecks) return 'high'
  if (held >= checks * CONFIDENCE_RULE.mediumMinShare) return 'medium'
  return 'low'
}

const ASSETS = [
  { id: 'ETH', file: 'eth-usd-1h.json', feed: 'Chainlink ETH/USD' },
  { id: 'BTC', file: 'btc-usd-1h.json', feed: 'Chainlink BTC/USD' },
]

export const METHOD =
  'Forecast from history. Origins: each UTC day 00:00 from 2021-03-25. Start = Chainlink oracle close of the hour ending at the origin. ' +
  'A fall of L touches when the lowest hourly oracle low in the next T days is at or below start × (1 − L); a rise of L when the highest hourly oracle high is at or above start × (1 + L). ' +
  'Rows follow validation/t1: calib origins whose window ends by 2024-01-01, test origins from 2024-01-01 whose window ends by 2026-10-06 03:00 UTC; the forecast pools both. ' +
  'Band: 90% moving-block bootstrap (blocks of max(30, 2T) days, 2000 replicates, seed 20261012). ' +
  'Confidence (preliminary): a check is a t1 level (5, 10, 15, 20, 30%) with at least one touch in either span; it holds when the 2024–26 frequency lies inside the 90% band built from 2021–23 rows only. ' +
  'High if every check holds and there are at least 4, medium if at least half hold, low otherwise, untested with no checks.'

const isoDay = (ts) => new Date(ts * 1000).toISOString().slice(0, 10)

// --------------------------------------------------------------- PRNG

/** xoshiro128** seeded through splitmix32. Deterministic; uniform 32-bit outputs. */
export function makeRng(seed) {
  let x = seed >>> 0
  const split = () => {
    x = (x + 0x9e3779b9) >>> 0
    let z = x
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0
    return (z ^ (z >>> 16)) >>> 0
  }
  let a = split()
  let b = split()
  let c = split()
  let d = split()
  const rotl = (v, k) => ((v << k) | (v >>> (32 - k))) >>> 0
  const next = () => {
    const r = Math.imul(rotl(Math.imul(b, 5) >>> 0, 7), 9) >>> 0
    const t = (b << 9) >>> 0
    c = (c ^ a) >>> 0
    d = (d ^ b) >>> 0
    b = (b ^ c) >>> 0
    a = (a ^ d) >>> 0
    c = (c ^ t) >>> 0
    d = rotl(d, 11)
    return r
  }
  /** Integer uniform on [0, m), by rejection (no modulo bias). */
  const int = (m) => {
    if (m <= 0) throw new Error('rng.int: m must be positive')
    const lim = Math.floor(0x100000000 / m) * m
    for (;;) {
      const v = next()
      if (v < lim) return v % m
    }
  }
  return { next, int }
}

// --------------------------------------------------------------- outcomes

/**
 * Per origin day and horizon: S, and the deepest whole level touched in each direction
 * (0 = not even 1%). Uses t1's own comparison, min ≤ S·(1 + k) with k = −L/100, at every
 * level, so a row at a t1 level reproduces t1's y exactly.
 */
export function outcomes(series, horizonDays, window = { from: CALIB_START, split: SPLIT, end: T1_END }) {
  const { startTs, close, low, high } = series
  const idx = (ts) => (ts - startTs) / HOUR
  const rows = []
  for (let t0 = window.from; t0 + DAY <= window.end; t0 += DAY) {
    const end = t0 + horizonDays * DAY
    const split = t0 < window.split ? (end <= window.split ? 'calib' : null) : end <= window.end ? 'test' : null
    if (!split) continue
    const S = close[idx(t0 - HOUR)]
    if (S === null || S === undefined || !(S > 0)) continue
    const j0 = idx(t0)
    const j1 = idx(end - HOUR)
    let lo = Infinity
    let hi = -Infinity
    let gap = false
    for (let j = j0; j <= j1; j++) {
      const a = low[j]
      const b = high[j]
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
    rows.push({ t0, split, S, min: lo, max: hi, fall, rise })
  }
  return rows
}

/** touched[L − 1] = rows whose deepest level ≥ L. */
export function touchedCounts(deepest) {
  const hist = new Array(LEVEL_MAX + 1).fill(0)
  for (const d of deepest) hist[d]++
  const out = new Array(LEVEL_MAX).fill(0)
  let acc = 0
  for (let L = LEVEL_MAX; L >= LEVEL_MIN; L--) {
    acc += hist[L]
    out[L - 1] = acc
  }
  return out
}

/** t1's block draw for one horizon: the block starts of every replicate. */
export function blockDraw(rng, nDays, horizonDays, replicates = BOOTSTRAP.replicates) {
  const b = Math.max(BOOTSTRAP.minBlockDays, BOOTSTRAP.blockPerHorizonDays * horizonDays)
  if (nDays < b) throw new Error(`blockDraw: ${nDays} days is shorter than one ${b}-day block`)
  const nb = Math.ceil(nDays / b)
  const starts = []
  for (let r = 0; r < replicates; r++) {
    const s = new Array(nb)
    for (let k = 0; k < nb; k++) s[k] = rng.int(nDays - b + 1)
    starts.push(s)
  }
  return { b, nb, starts, nDays }
}

/** 90% band of touch counts per level over the replicates of one draw. Integers. */
export function bandFromDraw(draw, deepest) {
  const { b, starts, nDays } = draw
  if (deepest.length !== nDays) throw new Error(`bandFromDraw: ${deepest.length} rows for a ${nDays}-day draw`)
  const R = starts.length
  const perLevel = Array.from({ length: LEVEL_MAX }, () => new Int32Array(R))
  const hist = new Int32Array(LEVEL_MAX + 1)
  for (let r = 0; r < R; r++) {
    hist.fill(0)
    let taken = 0
    for (const s of starts[r]) {
      for (let k = 0; k < b && taken < nDays; k++, taken++) hist[deepest[s + k]]++
    }
    let acc = 0
    for (let L = LEVEL_MAX; L >= LEVEL_MIN; L--) {
      acc += hist[L]
      perLevel[L - 1][r] = acc
    }
  }
  const qLo = (1 - BOOTSTRAP.band) / 2
  const qHi = 1 - qLo
  const lo = []
  const hi = []
  for (const arr of perLevel) {
    const s = Array.from(arr).sort((x, y) => x - y)
    lo.push(s[Math.floor(qLo * (R - 1))])
    hi.push(s[Math.ceil(qHi * (R - 1) - 1e-9)])
  }
  return { lo, hi }
}

// --------------------------------------------------------------- the t1 cross-check

/** Parses t1's forecasts CSV (no quoted fields) into the columns the check needs. */
export function parseT1Csv(text) {
  const lines = text.split('\n').filter(Boolean)
  const head = lines[0].split(',')
  const col = (n) => {
    const i = head.indexOf(n)
    if (i < 0) throw new Error(`t1 csv: no column ${n}`)
    return i
  }
  const ci = { asof: col('asof'), asset: col('asset'), T: col('T'), k: col('k'), S: col('S'), L: col('L'), y: col('y_oracle') }
  return lines.slice(1).map((l) => {
    const f = l.split(',')
    return {
      asset: f[ci.asset],
      t0: Date.parse(f[ci.asof]) / 1000,
      T: Number(f[ci.T]),
      k: Number(f[ci.k]),
      S: Number(f[ci.S]),
      L: Number(f[ci.L]),
      y: Number(f[ci.y]),
    }
  })
}

/**
 * Row by row: every t1 row (calib and test) has a row here with the same S, the same L
 * and the same truth, and every row here has a t1 row. Returns the frequency comparison
 * per asset × horizon × level; throws on the first mismatch.
 */
export function crossCheckT1(t1Rows, ours) {
  const key = (a, t0, T) => `${a}|${t0}|${T}`
  const mine = new Map()
  for (const [asset, byH] of Object.entries(ours)) {
    for (const [T, rows] of Object.entries(byH)) for (const r of rows) mine.set(key(asset, r.t0, Number(T)), r)
  }
  const seen = new Set()
  const freq = {}
  let compared = 0
  for (const t of t1Rows) {
    const r = mine.get(key(t.asset, t.t0, t.T))
    if (!r) throw new Error(`t1 cross-check: no row for ${t.asset} ${isoDay(t.t0)} T=${t.T}`)
    if (r.S !== t.S) throw new Error(`t1 cross-check: S ${r.S} ≠ t1 ${t.S} at ${t.asset} ${isoDay(t.t0)} T=${t.T}`)
    const L = r.S * (1 + t.k)
    if (L !== t.L) throw new Error(`t1 cross-check: L ${L} ≠ t1 ${t.L} at ${t.asset} ${isoDay(t.t0)} k=${t.k}`)
    const level = Math.round(-t.k * 100)
    const y = r.fall >= level ? 1 : 0
    if (y !== t.y) {
      throw new Error(`t1 cross-check: y ${y} ≠ t1 y_oracle ${t.y} at ${t.asset} ${isoDay(t.t0)} T=${t.T} k=${t.k}`)
    }
    seen.add(key(t.asset, t.t0, t.T))
    const fk = `${t.asset}|${t.T}|${level}`
    freq[fk] ??= { t1: 0, ours: 0, n: 0 }
    freq[fk].t1 += t.y
    freq[fk].ours += y
    freq[fk].n++
    compared++
  }
  if (seen.size !== mine.size) throw new Error(`t1 cross-check: ${mine.size - seen.size} of our rows have no t1 row`)
  for (const [k, v] of Object.entries(freq)) {
    if (v.t1 !== v.ours) throw new Error(`t1 cross-check: frequency mismatch at ${k}`)
  }
  return { rowsCompared: compared, origins: mine.size, freq }
}

// --------------------------------------------------------------- provenance

function shaFromProvenance(md, file) {
  const m = md.match(new RegExp('`' + file.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&') + '`\\s*\\|\\s*\\d+\\s*\\|\\s*`([0-9a-f]{64})`'))
  if (!m) throw new Error(`PROVENANCE.md has no sha256 row for ${file}`)
  return m[1]
}

function verified(dir, file) {
  const md = readFileSync(join(dir, 'PROVENANCE.md'), 'utf8')
  const want = shaFromProvenance(md, file)
  const buf = readFileSync(join(dir, file))
  const got = createHash('sha256').update(buf).digest('hex')
  if (got !== want) throw new Error(`${file}: sha256 ${got} does not match PROVENANCE.md ${want}`)
  return { buf, sha256: got }
}

// --------------------------------------------------------------- build

export function build(root = process.cwd()) {
  const base = datasetsDir(root)
  const ph = datasetPath(root, 'price-history')
  const t1dir = datasetPath(root, 'validation', 't1')
  let commit
  try {
    commit = execFileSync('git', ['-C', base, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    throw new Error(`could not read the datasets commit (git -C ${base} rev-parse HEAD)`)
  }

  const sha256 = {}
  const ours = {}
  for (const a of ASSETS) {
    const { buf, sha256: s } = verified(ph, a.file)
    sha256[`price-history/${a.file}`] = s
    const j = JSON.parse(buf.toString('utf8'))
    if (j.stepSeconds !== HOUR) throw new Error(`${a.file}: not hourly`)
    const end = j.startTs + j.count * HOUR
    if (end !== T1_END) {
      throw new Error(`${a.file}: series ends ${new Date(end * 1000).toISOString()}; t1 used 2026-10-06T03Z`)
    }
    const series = { startTs: j.startTs, close: j.columns.oracle, low: j.columns.oracleLow, high: j.columns.oracleHigh }
    ours[a.id] = {}
    for (const h of HORIZONS) ours[a.id][h.days] = outcomes(series, h.days)
  }

  // --- the t1 cross-check, row by row --------------------------------------------
  const t1Rows = []
  for (const f of ['forecasts-calib.csv.gz', 'forecasts-test.csv.gz']) {
    const { buf, sha256: s } = verified(t1dir, f)
    sha256[`validation/t1/${f}`] = s
    t1Rows.push(...parseT1Csv(gunzipSync(buf).toString('utf8')))
  }
  const check = crossCheckT1(t1Rows, ours)

  // --- bands: one draw per horizon (pooled span), then one per horizon (calib span) ----
  const rng = makeRng(BOOTSTRAP.seed)
  const draws = {}
  for (const h of HORIZONS) {
    const d = ours.ETH[h.days].map((r) => r.t0)
    if (d.join() !== ours.BTC[h.days].map((r) => r.t0).join()) throw new Error(`ETH and BTC origin days differ at T=${h.days}`)
    draws[h.days] = blockDraw(rng, d.length, h.days)
  }
  const calibDraws = {}
  for (const h of HORIZONS) {
    calibDraws[h.days] = blockDraw(rng, ours.ETH[h.days].filter((r) => r.split === 'calib').length, h.days)
  }

  const assets = {}
  for (const a of ASSETS) {
    const out = { feed: a.feed, fall: {}, rise: {} }
    for (const dir of ['fall', 'rise']) {
      for (const h of HORIZONS) {
        const rows = ours[a.id][h.days]
        const deepest = rows.map((r) => r[dir])
        const touched = touchedCounts(deepest)
        const { lo, hi } = bandFromDraw(draws[h.days], deepest)

        // Confidence: the calib-only band against the test-span frequency, at t1's levels.
        const calib = rows.filter((r) => r.split === 'calib').map((r) => r[dir])
        const test = rows.filter((r) => r.split === 'test').map((r) => r[dir])
        const cBand = bandFromDraw(calibDraws[h.days], calib)
        const cTouched = touchedCounts(calib)
        const tTouched = touchedCounts(test)
        const checks = []
        for (const L of T1_LEVELS) {
          const c = { n: calib.length, touched: cTouched[L - 1], lo: cBand.lo[L - 1], hi: cBand.hi[L - 1] }
          const t = { n: test.length, touched: tTouched[L - 1] }
          if (c.touched + t.touched === 0) continue
          // lo/n_c ≤ touched/n_t ≤ hi/n_c, in integers.
          const holds = c.lo * t.n <= t.touched * c.n && t.touched * c.n <= c.hi * t.n
          checks.push({ level: L, calib: c, test: t, holds })
        }
        const held = checks.filter((c) => c.holds).length
        out[dir][h.id] = {
          n: rows.length,
          from: isoDay(rows[0].t0),
          to: isoDay(rows[rows.length - 1].t0),
          touched,
          lo,
          hi,
          confidence: {
            label: confidenceLabel(held, checks.length),
            held,
            checks: checks.length,
            // One integer tuple per check; columns in `confidenceRule.detailColumns`.
            detail: checks.map((c) => [c.level, c.calib.n, c.calib.touched, c.calib.lo, c.calib.hi, c.test.n, c.test.touched, c.holds ? 1 : 0]),
          },
        }
      }
    }
    assets[a.id] = out
  }

  const lastT1 = ours.ETH[1][ours.ETH[1].length - 1].t0
  return {
    table: {
      schema: 2,
      method: METHOD,
      levels: { min: LEVEL_MIN, max: LEVEL_MAX, step: 1 },
      horizons: HORIZONS.map((h) => ({ id: h.id, days: h.days })),
      period: {
        from: isoDay(CALIB_START),
        to: isoDay(lastT1),
        calib: { from: isoDay(CALIB_START), to: isoDay(SPLIT - DAY) },
        test: { from: isoDay(SPLIT), to: isoDay(lastT1) },
        dataEnd: new Date(T1_END * 1000).toISOString(),
      },
      bootstrap: {
        scheme: 'moving blocks of max(30, 2T) origin days, ceil(N/b) per replicate, starts uniform on [0, N − b]',
        replicates: BOOTSTRAP.replicates,
        seed: BOOTSTRAP.seed,
        prng: 'xoshiro128** seeded by splitmix32',
        band: BOOTSTRAP.band,
        percentile: 'nearest rank, lower floored, upper ceiled',
      },
      confidenceRule: {
        levels: T1_LEVELS,
        highMinChecks: CONFIDENCE_RULE.highMinChecks,
        mediumMinShare: CONFIDENCE_RULE.mediumMinShare,
        preliminary: true,
        detailColumns: ['level', 'calibN', 'calibTouched', 'calibLo', 'calibHi', 'testN', 'testTouched', 'holds'],
      },
      t1Check: { rowsCompared: check.rowsCompared, origins: check.origins, mismatches: 0 },
      source: {
        repo: 'triccs/membrane-datasets',
        commit,
        paths: Object.keys(sha256),
        sha256,
        columns: { start: 'oracle', fall: 'oracleLow', rise: 'oracleHigh' },
      },
      generatedAt: new Date().toISOString(),
      assets,
    },
    check,
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) {
  const here = dirname(fileURLToPath(import.meta.url))
  const repo = resolve(here, '..', '..')
  const outPath = join(repo, 'lib', 'position', 'touchHistory.generated.json')
  const { table, check } = build(repo)
  // One line per array keeps the diff readable and the file small.
  const json = JSON.stringify(table, null, 1).replace(/\[\s*([\d,\s]+?)\s*\]/g, (_m, inner) => `[${inner.replace(/\s+/g, '')}]`)
  writeFileSync(outPath, json + '\n')
  console.log(`t1 cross-check: ${check.rowsCompared} rows, ${check.origins} origins, 0 mismatches`)
  for (const a of ['ETH', 'BTC'])
    for (const T of [1, 7, 30]) {
      const cells = T1_LEVELS.map((L) => {
        const f = check.freq[`${a}|${T}|${L}`]
        return `${L}%: ${f.t1}/${f.n}`
      })
      console.log(`  ${a} T=${T}d  ${cells.join('  ')}`)
    }
  const e = table.assets.ETH.fall['7d']
  const pct = (x) => ((x / e.n) * 100).toFixed(1)
  for (const L of [10, 20, 30]) {
    console.log(`ETH 7d fall ${L}%: ${pct(e.touched[L - 1])}% (90% ${pct(e.lo[L - 1])}–${pct(e.hi[L - 1])}%) n ${e.n}`)
  }
  for (const a of ['ETH', 'BTC'])
    for (const d of ['fall', 'rise']) {
      const cells = table.horizons.map((h) => {
        const c = table.assets[a][d][h.id].confidence
        return `${h.id} ${c.label} (${c.held}/${c.checks})`
      })
      console.log(`${a} ${d}: ${cells.join(' · ')}`)
    }
  console.log(`wrote ${outPath}`)
}
