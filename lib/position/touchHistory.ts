/**
 * Typed access to the generated touch-history table (touchHistory.generated.json).
 *
 * The table is HISTORY: on how many days, over a named period, ETH or BTC moved L% or
 * more within T days. It is never a forecast and never odds (DESIGN_RULES §4, §5b). The
 * builder is scripts/position/build-touch-history.mjs; its METHOD string travels in the
 * file and is rendered on the page.
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

export interface TouchRow {
  /** Daily origins counted. */
  n: number
  /** First and last origin, ISO dates (UTC). */
  from: string
  to: string
  /** touched[L − levels.min] = origins whose window touched L%. */
  touched: number[]
}

export interface TouchAssetTable {
  feed: string
  oracleGradeFrom: string
  fall: Record<HorizonId, TouchRow>
  rise: Record<HorizonId, TouchRow>
}

export interface TouchTable {
  schema: 1
  method: string
  levels: { min: number; max: number; step: number }
  horizons: { id: HorizonId; hours: number }[]
  maxNullShare: number
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
  if (o.schema !== 1) bad(`schema ${String(o.schema)}`)
  if (!o.levels || o.levels.step !== 1 || !(o.levels.max > o.levels.min)) bad('levels')
  const width = o.levels.max - o.levels.min + 1
  if (typeof o.source?.commit !== 'string' || o.source.commit.length < 7) bad('source.commit')
  for (const a of ['ETH', 'BTC'] as const) {
    const at = o.assets?.[a]
    if (!at) bad(`assets.${a}`)
    for (const d of ['fall', 'rise'] as const) {
      for (const h of HORIZON_IDS) {
        const r = at[d]?.[h]
        if (!r) bad(`${a}.${d}.${h} missing`)
        if (!Number.isInteger(r.n) || r.n <= 0) bad(`${a}.${d}.${h}.n`)
        if (!Array.isArray(r.touched) || r.touched.length !== width) bad(`${a}.${d}.${h}.touched`)
        if (r.touched.some((x) => !Number.isInteger(x) || x < 0 || x > r.n)) {
          bad(`${a}.${d}.${h}.touched out of range`)
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(r.from) || !/^\d{4}-\d{2}-\d{2}$/.test(r.to)) {
          bad(`${a}.${d}.${h} period`)
        }
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

/** "2020–26" from the widest period across horizons. */
export function periodYears(t: TouchTable, asset: HistoryAsset, direction: Direction): string {
  const rows = HORIZON_IDS.map((h) => t.assets[asset][direction][h])
  const from = rows.reduce((m, r) => (r.from < m ? r.from : m), rows[0].from)
  const to = rows.reduce((m, r) => (r.to > m ? r.to : m), rows[0].to)
  const y0 = from.slice(0, 4)
  const y1 = to.slice(0, 4)
  return y0 === y1 ? y0 : `${y0}–${y1.slice(2)}`
}
