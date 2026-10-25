/**
 * The cell registry: data, not code. lib/forecast/registry.json is generated from the Q26 UI confidence map by
 * scripts/forecast/gen_registry.py (see its header for the regenerate and hand-edit procedures).
 * The UI renders whatever each cell's class allows, so a regrade flows through by data alone.
 */
import registryJson from './registry.json'
import type { AssetSpec, CellClass, Display, ForecastCell, Purpose, Registry } from './types'

const CLASSES: CellClass[] = ['SKILL', 'CALIBRATED_WARN', 'CALIBRATED', 'RECALIBRATE', 'PENDING', 'SCENARIO', 'HISTORY_COUNT', 'DO_NOT_SHOW']
/** Classes that may show a probability (owner rule, Q41). */
export const PROBABILITY_CLASSES: ReadonlySet<CellClass> = new Set<CellClass>(['SKILL', 'CALIBRATED_WARN', 'CALIBRATED'])

/** Parse and validate a registry object. Throws on a malformed row (fail closed). */
export function parseRegistry(raw: unknown): Registry {
  const r = raw as Registry
  if (!r || r.schema !== 'membrane-forecast-registry/1') throw new Error('forecast registry: unknown schema')
  if (!Array.isArray(r.cells) || !Array.isArray(r.assets)) throw new Error('forecast registry: cells/assets missing')
  const seen = new Set<string>()
  for (const c of r.cells) {
    if (!CLASSES.includes(c.class) || !CLASSES.includes(c.gradedClass)) throw new Error(`forecast registry: bad class in ${c.id}`)
    if (!(c.horizonH > 0) || !(c.levelPct < 0)) throw new Error(`forecast registry: bad horizon/level in ${c.id}`)
    if (c.id !== `${c.group}:${c.horizonH}h:${c.levelPct}`) throw new Error(`forecast registry: id mismatch ${c.id}`)
    if (seen.has(c.id)) throw new Error(`forecast registry: duplicate ${c.id}`)
    seen.add(c.id)
    if (c.class === 'CALIBRATED_WARN' && c.label !== 'calibrated, not proven better than alternatives') {
      throw new Error(`forecast registry: ${c.id} CALIBRATED_WARN needs the required label`)
    }
    if (c.trigger && !(c.class === 'SKILL' || c.class === 'CALIBRATED_WARN')) throw new Error(`forecast registry: ${c.id} trigger on ${c.class}`)
  }
  return r
}

let cached: Registry | null = null
export function defaultRegistry(): Registry {
  if (!cached) cached = parseRegistry(registryJson)
  return cached
}

export function resolveAsset(reg: Registry, asset: string): AssetSpec | null {
  const a = asset.trim().toLowerCase()
  return reg.assets.find((x) => x.symbol.toLowerCase() === a) ?? null
}

export function findCell(reg: Registry, group: string, horizonH: number, levelPct: number): ForecastCell | null {
  return reg.cells.find((c) => c.group === group && c.horizonH === horizonH && Math.abs(c.levelPct - levelPct) < 1e-9) ?? null
}

export function cellsFor(reg: Registry, group: string, horizonH?: number): ForecastCell[] {
  return reg.cells.filter((c) => c.group === group && (horizonH === undefined || c.horizonH === horizonH))
}

export function isNearLine(reg: Registry, horizonH: number, levelPct: number): boolean {
  const r = reg.nearLine
  return horizonH >= r.minHorizonH && horizonH <= r.maxHorizonH && Math.abs(levelPct) <= r.maxAbsLevelPct
}

/** What a cell allows, before any model run. */
export function gate(reg: Registry, cell: ForecastCell | null, purpose: Purpose): { display: Display; reason: string | null } {
  if (!cell) return { display: 'none', reason: 'no registry cell for this horizon and level (no cell is invented)' }
  switch (cell.class) {
    case 'SKILL':
    case 'CALIBRATED_WARN':
    case 'CALIBRATED':
      if (cell.model !== 'raw_fH') return { display: 'none', reason: 'this cell needs the frozen C3 recalibration, which the engine does not port' }
      if (purpose === 'line' && isNearLine(reg, cell.horizonH, cell.levelPct)) return { display: 'none', reason: reg.nearLine.reason }
      return { display: 'probability', reason: null }
    case 'HISTORY_COUNT':
      return { display: 'count', reason: 'outside every model range: history count only' }
    case 'RECALIBRATE':
      return { display: 'none', reason: 'informative but miscalibrated, no validated recalibration: no probability' }
    case 'PENDING':
      return { display: 'none', reason: 'pending a live verdict: research build only' }
    case 'SCENARIO':
      return { display: 'none', reason: 'scenario only: no frequency' }
    case 'DO_NOT_SHOW':
    default:
      return { display: 'none', reason: 'DO NOT SHOW: failed its test or never tested on a display path' }
  }
}
