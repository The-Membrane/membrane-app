// Pure helpers the forecast block draws from: the STALE hatch and the curve's marks.

import { NEWS } from '@/components/NewsEdition/tokens'
import { fmtMove } from '@/lib/position/format'
import { formatChance } from '@/lib/position/touch'

import type { CurveMark } from './TouchGradientSlot'
import type { ForecastView, HorizonForecast } from './viewModel'

/** The hatch for STALE: ink rules at 45°, never a colour (DESIGN_RULES §4). */
export const STALE_HATCH = `repeating-linear-gradient(45deg, ${NEWS.rule} 0 1px, transparent 1px 7px)`

/** The marks the curve draws for one horizon: the reader's ring and one dot per lever. */
export function curveMarks(f: ForecastView, hf: HorizonForecast): { you: CurveMark | null; actions: CurveMark[] } {
  const you = hf.at
    ? { level: hf.at.level, pct: hf.at.pct, label: `your line ${fmtMove(hf.at.level, f.direction)} · ${formatChance(hf.at.touched, hf.at.n)}` }
    : null
  // One dot per level the levers reach; a repay names it when both kinds land there.
  const byLevel = new Map<number, CurveMark>()
  const rank = (k: string) => (k === 'repay' ? 0 : 1)
  for (const a of [...hf.actions].sort((p, q) => rank(p.kind) - rank(q.kind))) {
    if (!byLevel.has(a.newDistancePct)) byLevel.set(a.newDistancePct, { level: a.newDistancePct, pct: a.history.pct, label: a.short })
  }
  return { you, actions: [...byLevel.values()].sort((p, q) => p.level - q.level) }
}
