// Shared geometry for the two equity charts on /simulator.
//
// EquityChart (the full-width diagnostic) and HeroChart (the animated hero graphic)
// draw the SAME two series. Keeping the scales, the down-sampling and the null-gap
// splitting in one place means the hero can never draw a curve the detail chart
// disagrees with.

export interface ChartBox {
  w: number
  h: number
  padL: number
  padR: number
  padT: number
  padB: number
}

export interface Pt {
  x: number
  y: number
  i: number
}

/** Picks every nth minute so the polyline stays under `target`, keeping the last. */
export function sample(
  series: (number | null)[],
  target: number,
): { i: number; v: number | null }[] {
  const step = Math.max(1, Math.ceil(series.length / target))
  const out: { i: number; v: number | null }[] = []
  for (let i = 0; i < series.length; i += step) out.push({ i, v: series[i] })
  const last = series.length - 1
  if (last < 0) return out
  if (out.length === 0 || out[out.length - 1].i !== last) out.push({ i: last, v: series[last] })
  return out
}

/**
 * The shared y-range for both engines.
 *
 * Zero is always included so "equity went to nothing" reads as a distance rather than
 * a rescaled line that looks like a mild drawdown.
 */
export function equityRange(...series: (number | null)[][]): { min: number; max: number } {
  const finite = series.flat().filter((v): v is number => v !== null && Number.isFinite(v))
  const rawMin = finite.length ? Math.min(...finite) : 0
  const rawMax = finite.length ? Math.max(...finite) : 1
  const min = Math.min(0, rawMin)
  return { min, max: Math.max(rawMax, min + 1) }
}

export interface Scales {
  xOf: (i: number) => number
  yOf: (v: number) => number
}

export function makeScales(box: ChartBox, count: number, min: number, max: number): Scales {
  const span = max - min || 1
  return {
    xOf: (i) => box.padL + ((box.w - box.padL - box.padR) * i) / Math.max(1, count - 1),
    yOf: (v) => box.padT + (box.h - box.padT - box.padB) * (1 - (v - min) / span),
  }
}

/** Splits into unbroken runs so null minutes leave a visible break in the line. */
export function toRuns(series: (number | null)[], scales: Scales, target: number): Pt[][] {
  const runs: Pt[][] = []
  let run: Pt[] = []
  for (const { i, v } of sample(series, target)) {
    if (v === null || !Number.isFinite(v)) {
      if (run.length) runs.push(run)
      run = []
      continue
    }
    run.push({ x: scales.xOf(i), y: scales.yOf(v), i })
  }
  if (run.length) runs.push(run)
  return runs
}

export const pathD = (run: Pt[]): string =>
  run.map((p, k) => `${k === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
