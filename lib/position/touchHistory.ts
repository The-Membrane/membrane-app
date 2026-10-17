/**
 * Typed access to the generated forecast table (touchHistory.generated.json).
 *
 * Each cell is a FORECAST from history (FORECAST_VISUALS.md, option C): the share of past
 * daily origins (2021-03-25 on, validation/t1's rows) on which ETH or BTC touched a line
 * L% away within T days, with a 90% block-bootstrap band and a preliminary confidence
 * label per asset × horizon. The builder is scripts/position/build-touch-history.mjs and
 * it asserts the outcome definition row by row against validation/t1. Its METHOD string
 * travels in the file.
 */

import raw from './touchHistory.generated.json'

export type HistoryAsset = 'ETH' | 'BTC'
export type Direction = 'fall' | 'rise'
export type HorizonId = '1d' | '3d' | '7d' | '14d' | '30d'

export const HORIZON_IDS: readonly HorizonId[] = ['1d', '3d', '7d', '14d', '30d']

/** "within 7 days" */
export const HORIZON_WORDS: Record<HorizonId, string> = {
  '1d': '1 day',
  '3d': '3 days',
  '7d': '7 days',
  '14d': '14 days',
  '30d': '30 days',
}

/** Labels the preliminary span check can produce. Q26's labels will replace the source. */
export type ConfidenceLabel = 'high' | 'medium' | 'low' | 'untested'

export interface CellConfidence {
  label: ConfidenceLabel
  /** Checks that held, and checks run (t1 levels with at least one touch). */
  held: number
  checks: number
  /** [level, calibN, calibTouched, calibLo, calibHi, testN, testTouched, holds] per check. */
  detail: number[][]
}

export interface TouchRow {
  /** Daily origins counted (t1's calib ∪ test rows at this horizon). */
  n: number
  /** First and last origin, ISO dates (UTC). */
  from: string
  to: string
  /** touched[L − levels.min] = origins whose window touched L%. */
  touched: number[]
  /** 90% block-bootstrap band of the same count, per level; `hi` floored at 3T (bootstrap.bandTopFloor). */
  lo: number[]
  hi: number[]
  confidence: CellConfidence
}

export interface TouchAssetTable {
  feed: string
  fall: Record<HorizonId, TouchRow>
  rise: Record<HorizonId, TouchRow>
}

export interface TouchTable {
  schema: 2
  method: string
  levels: { min: number; max: number; step: number }
  horizons: { id: HorizonId; days: number }[]
  period: {
    from: string
    to: string
    calib: { from: string; to: string }
    test: { from: string; to: string }
    /** End of the last hour the table observed (ISO). */
    dataEnd: string
  }
  bootstrap: {
    scheme: string
    replicates: number
    seed: number
    prng: string
    band: number
    percentile: string
    /** How the band's top is floored: 3T of n, the rule of three on independent windows. */
    bandTopFloor: string
  }
  confidenceRule: {
    levels: number[]
    highMinChecks: number
    mediumMinShare: number
    preliminary: boolean
    detailColumns: string[]
  }
  t1Check: { rowsCompared: number; origins: number; mismatches: number }
  source: {
    repo: string
    commit: string
    paths: string[]
    sha256: Record<string, string>
    columns: { start: string; fall: string; rise: string }
  }
  generatedAt: string
  assets: Record<HistoryAsset, TouchAssetTable>
}

const LABELS: readonly ConfidenceLabel[] = ['high', 'medium', 'low', 'untested']

/**
 * Structural check of a parsed table. Throws naming the first broken field, so a bad
 * regeneration fails the unit test rather than rendering a wrong number.
 */
export function assertTouchTable(t: unknown): asserts t is TouchTable {
  const bad = (what: string): never => {
    throw new Error(`touch table: ${what}`)
  }
  if (!t || typeof t !== 'object') bad('not an object')
  const o = t as TouchTable
  if (o.schema !== 2) bad(`schema ${String(o.schema)}`)
  if (!o.levels || o.levels.step !== 1 || !(o.levels.max > o.levels.min)) bad('levels')
  const width = o.levels.max - o.levels.min + 1
  if (typeof o.source?.commit !== 'string' || o.source.commit.length < 7) bad('source.commit')
  if (!o.period || !/^\d{4}-\d{2}-\d{2}T/.test(o.period.dataEnd)) bad('period.dataEnd')
  if (o.t1Check?.mismatches !== 0) bad('t1Check')
  const ints = (xs: unknown, n: number, max: number) =>
    Array.isArray(xs) && xs.length === n && xs.every((x) => Number.isInteger(x) && x >= 0 && x <= max)
  for (const a of ['ETH', 'BTC'] as const) {
    const at = o.assets?.[a]
    if (!at) bad(`assets.${a}`)
    for (const d of ['fall', 'rise'] as const) {
      for (const h of HORIZON_IDS) {
        const r = at[d]?.[h]
        const id = `${a}.${d}.${h}`
        if (!r) bad(`${id} missing`)
        if (!Number.isInteger(r.n) || r.n <= 0) bad(`${id}.n`)
        if (!ints(r.touched, width, r.n)) bad(`${id}.touched`)
        if (!ints(r.lo, width, r.n) || !ints(r.hi, width, r.n)) bad(`${id} band`)
        if (r.lo.some((x, i) => x > r.hi[i])) bad(`${id} band crosses`)
        if (!/^\d{4}-\d{2}-\d{2}$/.test(r.from) || !/^\d{4}-\d{2}-\d{2}$/.test(r.to)) bad(`${id} period`)
        const c = r.confidence
        if (!c || !LABELS.includes(c.label) || !(c.held >= 0 && c.held <= c.checks)) bad(`${id} confidence`)
      }
    }
  }
}

const parsed: unknown = raw
assertTouchTable(parsed)

/** The generated table, checked once at module load. */
export const TOUCH_TABLE: TouchTable = parsed

/** "42c792d" — the datasets commit the table was built from. */
export const shortSha = (t: TouchTable = TOUCH_TABLE): string => t.source.commit.slice(0, 7)

/** "2021–26" — the origins' years. */
export function periodYears(t: TouchTable): string {
  const y0 = t.period.from.slice(0, 4)
  const y1 = t.period.to.slice(0, 4)
  return y0 === y1 ? y0 : `${y0}–${y1.slice(2)}`
}

/** "≈ 1,990": the mean origins per horizon, to the nearest 10. */
export function meanN(t: TouchTable, asset: HistoryAsset, direction: Direction): number {
  const ns = HORIZON_IDS.map((h) => t.assets[asset][direction][h].n)
  return Math.round(ns.reduce((a, b) => a + b, 0) / ns.length / 10) * 10
}

/**
 * STALE after this many days without new data. The longest horizon the page quotes is
 * 30 days: once the table's last observed hour is more than one longest horizon old, a
 * whole 30-day window of recent market behaviour is missing from every row it quotes, so
 * the headline number is hidden and the block hatched (FORECAST_VISUALS.md: "When STALE,
 * hatch the block and hide the big number").
 */
export const STALE_AFTER_DAYS = 30

export function isStale(t: TouchTable, nowMs: number): boolean {
  return nowMs - Date.parse(t.period.dataEnd) > STALE_AFTER_DAYS * 86_400_000
}

/** Whole days since the table's last observed hour when it is STALE; null while fresh. */
export function staleDays(t: TouchTable, nowMs: number): number | null {
  return isStale(t, nowMs) ? Math.floor((nowMs - Date.parse(t.period.dataEnd)) / 86_400_000) : null
}

/** Whole days since the table's last observed hour (never negative). */
export function dataAgeDays(t: TouchTable, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - Date.parse(t.period.dataEnd)) / 86_400_000))
}

/** When the table turns STALE, "2026-11-05 03:00 UTC": one STALE_AFTER_DAYS span after its last hour. */
export function staleOn(t: TouchTable): string {
  // The exact instant, to the minute: a date alone would read as midnight, hours early.
  const iso = new Date(Date.parse(t.period.dataEnd) + STALE_AFTER_DAYS * 86_400_000).toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}

/**
 * The data's age, said where the forecast is quoted (owner, 2026-10-17: make the STALE date
 * math visible). "History through 2026-10-06 · 11 days old · STALE from 2026-11-05"; once
 * STALE: "History through 2026-10-06 · 45 days old · STALE since 2026-11-05".
 */
export function dataAgeLine(t: TouchTable, nowMs: number): string {
  const age = dataAgeDays(t, nowMs)
  const days = age === 1 ? '1 day' : `${age} days`
  const head = `History through ${t.period.dataEnd.slice(0, 10)} · ${days} old`
  return isStale(t, nowMs) ? `${head} · STALE since ${staleOn(t)}` : `${head} · STALE from ${staleOn(t)}`
}
