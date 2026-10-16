// Pure helpers the forecast block draws from: the STALE hatch, the chance strip's cells and
// the curve's marks.

import { NEWS } from '@/components/NewsEdition/tokens'
import { fmtMove } from '@/lib/position/format'
import { bandLowPct, bandTopPct, chanceShownPct, formatChance, type TouchFrequency } from '@/lib/position/touch'

import { LEVER_KINDS, type LeverKind } from './curveLayout'
import type { ForecastView, HorizonForecast } from './viewModel'

/** The hatch for STALE: ink rules at 45°, never a colour (DESIGN_RULES §4). */
export const STALE_HATCH = `repeating-linear-gradient(45deg, ${NEWS.rule} 0 1px, transparent 1px 7px)`

/**
 * THE CHANCE STRIP: 100 cells, one per percent. `inked` cells are the chance as printed
 * (rounded up; "<1%" inks none). The likely range runs from `bandFrom` to `bandTo`, the
 * printed band's own ends; the cells inside it past the inked run are drawn lighter.
 */
export interface ChanceCells {
  inked: number
  bandFrom: number
  bandTo: number
}

export function chanceCells(f: Pick<TouchFrequency, 'touched' | 'lo' | 'hi' | 'n'>): ChanceCells {
  const clamp = (v: number) => Math.max(0, Math.min(100, v))
  const inked = clamp(chanceShownPct(f.touched, f.n))
  const bandTo = Math.max(inked, clamp(bandTopPct(f.hi, f.n)))
  const bandFrom = Math.min(inked, clamp(bandLowPct(f.lo, f.n)))
  return { inked, bandFrom, bandTo }
}

/** The reader's mark on the curve. */
export interface YouMark {
  level: number
  pct: number
  /** "your line −21% · 6%" */
  label: string
}

/** One point on the curve that one or more levers reach. */
export interface LeverPoint {
  level: number
  pct: number
  /** The lever kinds that reach this level, in LEVER_KINDS order. */
  kinds: LeverKind[]
  /** "→ 5%": the chance at this level. The markers' shapes and the legend name the lever. */
  label: string
  /** The rows' own lines, for the accessible summary: "If you repay 20 USDC → 5%". */
  detail: string[]
}

/** The marks the curve draws for one horizon: the reader's ring and one point per lever level. */
export function curveMarks(f: ForecastView, hf: HorizonForecast): { you: YouMark | null; levers: LeverPoint[] } {
  const you = hf.at
    ? { level: hf.at.level, pct: hf.at.pct, label: `your line ${fmtMove(hf.at.level, f.direction)} · ${formatChance(hf.at.touched, hf.at.n)}` }
    : null
  // A repay and a top-up solved for one target usually land on the same level: one point,
  // one marker per kind. Every point at one level has the same forecast, so one label.
  const byLevel = new Map<number, LeverPoint>()
  for (const a of hf.actions) {
    const p = byLevel.get(a.newDistancePct)
    if (p) {
      if (!p.kinds.includes(a.kind)) p.kinds.push(a.kind)
      p.detail.push(a.short)
    } else {
      byLevel.set(a.newDistancePct, {
        level: a.newDistancePct,
        pct: a.history.pct,
        kinds: [a.kind],
        label: `→ ${formatChance(a.history.touched, a.history.n)}`,
        detail: [a.short],
      })
    }
  }
  const rank = (k: LeverKind) => LEVER_KINDS.indexOf(k)
  const levers = [...byLevel.values()].sort((p, q) => p.level - q.level)
  for (const p of levers) p.kinds.sort((a, b) => rank(a) - rank(b))
  return { you, levers }
}
