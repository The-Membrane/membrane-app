/**
 * Forecast engine (lane Q41): registry gating + the raw (fH) port + history counts.
 */
import { FhSeriesModel } from './fh'
import { cellsFor, defaultRegistry, findCell, gate, isNearLine, PROBABILITY_CLASSES, resolveAsset } from './registry'
import { HOUR } from './series'
import type {
  ForecastCell, HistoryCount, PriceSeries, ReachResult, ReachRow, Registry, TouchOptions, TouchResult,
} from './types'

const models = new WeakMap<PriceSeries, FhSeriesModel>()

/** One cached model per series object (rebuild the series object to pick up new bars). */
export function modelFor(s: PriceSeries): FhSeriesModel {
  let m = models.get(s)
  if (!m) { m = new FhSeriesModel(s); models.set(s, m) }
  return m
}

export function originOf(ts: number): number {
  return Math.floor(ts / HOUR) * HOUR
}

function none(originTs: number, reason: string, cell: ForecastCell | null = null, spot: number | null = null): TouchResult {
  return { p: null, cell, display: 'none', label: '', reason, originTs, spot }
}

/**
 * "fell this far within T, K times since YEAR". Declustered: scanning hourly origins from the first one, an origin
 * whose next T hours reach spot x (1 + level) is an episode, and the scan then skips T hours. Only windows that end
 * at or before asOfTs are scanned. n = the number of disjoint T-hour windows in the scanned span (context only).
 */
export function historyCount(series: PriceSeries, asOfTs: number, horizonH: number, levelPct: number, opts: { sinceTs?: number } = {}): HistoryCount | null {
  if (!(horizonH > 0) || !Number.isInteger(horizonH) || !(levelPct < 0) || levelPct <= -100) return null
  const m = modelFor(series)
  const w = m.windowMin(horizonH)
  const end = Math.min(m.originIndex(originOf(asOfTs)), m.N) - horizonH // last origin whose window ends by asOfTs
  let i0 = 1
  if (opts.sinceTs !== undefined) i0 = Math.max(1, Math.ceil(m.originIndex(opts.sinceTs)))
  while (i0 <= end && !(Number.isFinite(m.spot[i0]) && Number.isFinite(w[i0]))) i0++
  if (i0 > end) return null
  const f = 1 + levelPct / 100
  let k = 0
  for (let i = i0; i <= end; i++) {
    const s = m.spot[i]
    const lo = w[i]
    if (Number.isFinite(s) && Number.isFinite(lo) && lo <= s * f) { k++; i += horizonH - 1 }
  }
  const firstTs = m.startTs + HOUR * i0
  return {
    k, n: Math.floor((end - i0 + 1) / horizonH), since: String(new Date(firstTs * 1000).getUTCFullYear()),
    horizonH, levelPct, firstTs, lastTs: m.startTs + HOUR * end, seriesId: series.id,
  }
}

interface Ctx { reg: Registry; group: string; seriesOk: boolean; reason: string | null }

function context(asset: string, series: PriceSeries | null, reg: Registry): Ctx {
  const spec = resolveAsset(reg, asset)
  if (!spec || !spec.group) return { reg, group: '', seriesOk: false, reason: `asset ${asset} is not in the forecast registry` }
  if (!spec.series) return { reg, group: spec.group, seriesOk: false, reason: `${asset}: ${spec.note}` }
  if (!series) return { reg, group: spec.group, seriesOk: false, reason: `${asset}: no price series supplied (needs ${spec.series})` }
  if (series.id !== spec.series) return { reg, group: spec.group, seriesOk: false, reason: `${asset}: series ${series.id} supplied, ${spec.series} required` }
  return { reg, group: spec.group, seriesOk: true, reason: null }
}

/** Levels (fractions) of one horizon's ladder: every registry level of the group, shallow -> deep. */
function ladder(reg: Registry, group: string, horizonH: number, extra?: number): number[] {
  const lv = new Set(cellsFor(reg, group, horizonH).map((c) => c.levelPct))
  if (extra !== undefined) lv.add(extra)
  return [...lv].sort((a, b) => b - a).map((p) => p / 100)
}

function fromCell(ctx: Ctx, cell: ForecastCell | null, series: PriceSeries | null, originTs: number, opts: TouchOptions, pred?: Map<number, ReturnType<FhSeriesModel['predict']>>): TouchResult {
  const purpose = opts.purpose ?? 'line'
  const g = gate(ctx.reg, cell, purpose)
  if (!cell) return none(originTs, g.reason as string)
  if (g.display === 'none') return none(originTs, g.reason as string, cell)
  if (!ctx.seriesOk || !series) return none(originTs, ctx.reason ?? 'no price series', cell)
  if (g.display === 'count') {
    const count = historyCount(series, originTs, cell.horizonH, cell.levelPct, { sinceTs: opts.countSinceTs })
    if (!count) return none(originTs, 'no price history before this moment', cell)
    return { p: null, cell, display: 'count', label: cell.label, reason: g.reason, count, originTs, spot: spotAt(series, originTs) }
  }
  let r = pred?.get(cell.horizonH)
  if (!r) {
    r = modelFor(series).predict(originTs, cell.horizonH, ladder(ctx.reg, ctx.group, cell.horizonH))
    pred?.set(cell.horizonH, r)
  }
  if ('error' in r) return none(originTs, `model not issued: ${r.error}`, cell)
  const j = r.levels.findIndex((k) => Math.abs(k * 100 - cell.levelPct) < 1e-9)
  return {
    p: r.fH[j], cell, display: 'probability', label: cell.label, reason: null, originTs, spot: r.spot, fallback: r.fallback,
    model: { quarter: r.quarter, nTrain: r.nTrain, sigmaH: r.sigmaH, sigmaF: r.sigmaF },
  }
}

function spotAt(series: PriceSeries, originTs: number): number | null {
  const j = (originTs - series.startTs) / HOUR - 1
  const v = j >= 0 && j < series.close.length ? series.close[j] : null
  return v ?? null
}

export function touchProbability(asset: string, asOfTs: number, horizonH: number, levelPct: number, priceSeries: PriceSeries | null, opts: TouchOptions = {}): TouchResult {
  const reg = opts.registry ?? defaultRegistry()
  const originTs = originOf(asOfTs)
  const ctx = context(asset, priceSeries, reg)
  if (!ctx.group) return none(originTs, ctx.reason as string)
  return fromCell(ctx, findCell(reg, ctx.group, horizonH, levelPct), priceSeries, originTs, opts)
}

export function whatCanWeSay(asset: string, asOfTs: number, priceSeries: PriceSeries | null, opts: TouchOptions = {}): TouchResult[] {
  const reg = opts.registry ?? defaultRegistry()
  const originTs = originOf(asOfTs)
  const ctx = context(asset, priceSeries, reg)
  if (!ctx.group) return []
  const pred = new Map<number, ReturnType<FhSeriesModel['predict']>>()
  const out: TouchResult[] = []
  for (const c of cellsFor(reg, ctx.group)) {
    if (!(PROBABILITY_CLASSES.has(c.class) || c.class === 'HISTORY_COUNT')) continue
    const r = fromCell(ctx, c, priceSeries, originTs, opts, pred)
    if (r.display !== 'none') out.push(r)
  }
  return out
}

export function reach(asset: string, nowTs: number, lineDistancePct: number, priceSeries: PriceSeries | null, opts: TouchOptions = {}): ReachResult {
  const reg = opts.registry ?? defaultRegistry()
  const originTs = originOf(nowTs)
  const line = -Math.abs(lineDistancePct)
  const base: ReachResult = { asset, originTs, lineDistancePct: line, rows: [], throughLine: false, reason: null }
  const ctx = context(asset, priceSeries, reg)
  if (!ctx.group) return { ...base, reason: ctx.reason }
  if (!(line < 0)) return { ...base, throughLine: true, reason: 'spot is at or through the line: act now (no probability; R27 / R12.7)' }
  if (line <= -100) return { ...base, reason: 'line distance must be above -100%' }
  const o: TouchOptions = { ...opts, purpose: 'line' }
  const pred = new Map<number, ReturnType<FhSeriesModel['predict']>>()
  for (const h of reg.horizonsH) {
    const shown = cellsFor(reg, ctx.group, h).filter((c) => gate(reg, c, 'price').display === 'probability')
    if (shown.length === 0) continue
    const levels = shown.map((c) => c.levelPct).sort((a, b) => b - a)
    const shallowPct = levels[0]
    const edgePct = levels[levels.length - 1]
    const row: ReachRow = { horizonH: h, status: 'none', edgePct, shallowPct, result: null, isUpperBound: false, reason: null }
    if (isNearLine(reg, h, line)) {
      row.reason = reg.nearLine.reason
    } else if (line < edgePct - 1e-9) {
      row.status = 'beyond'
      const count = priceSeries && ctx.seriesOk ? historyCount(priceSeries, originTs, h, line, { sinceTs: opts.countSinceTs }) : null
      if (count) row.count = count
      row.reason = `the line is deeper than every displayable level at ${h} h (edge ${edgePct}%)${count ? ': history count only' : ''}`
    } else if (line > shallowPct + 1e-9) {
      row.reason = `the line is shallower than every displayable level at ${h} h (${shallowPct}%)`
    } else {
      const at = levels.filter((l) => l >= line - 1e-9)
      const lvl = at[at.length - 1]
      const cell = findCell(reg, ctx.group, h, lvl)
      const r = fromCell(ctx, cell, priceSeries, originTs, o, pred)
      row.status = 'inside'
      row.result = r
      row.isUpperBound = Math.abs(lvl - line) > 1e-9
      row.reason = r.display === 'none' ? r.reason : row.isUpperBound ? `probability of reaching ${lvl}%, an upper bound for the line at ${line.toFixed(2)}%` : null
    }
    base.rows.push(row)
  }
  return base
}
