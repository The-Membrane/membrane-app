import React, { useMemo } from 'react'
import { Box } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import type { ChoiceRecord, SaleRecord, Scenario } from '@/lib/practice/engine'

const W = 1000
const H = 80

/**
 * The oracle price across the whole window, drawn faint, with the played part solid.
 * Sales are red ticks, the reader's choices are green ticks.
 */
export const PriceStrip: React.FC<{
  sc: Scenario
  upTo: number
  sales: SaleRecord[]
  choices: ChoiceRecord[]
}> = ({ sc, upTo, sales, choices }) => {
  const { full, lo, hi } = useMemo(() => {
    let lo = Infinity
    let hi = -Infinity
    for (const p of sc.prices) {
      if (p < lo) lo = p
      if (p > hi) hi = p
    }
    // Downsample to <= W points.
    const stride = Math.max(1, Math.floor(sc.count / W))
    const pts: string[] = []
    for (let i = 0; i < sc.count; i += stride) pts.push(`${(i / (sc.count - 1)) * W},${y(sc.prices[i], lo, hi)}`)
    return { full: pts.join(' '), lo, hi }
  }, [sc])

  const played = useMemo(() => {
    const stride = Math.max(1, Math.floor(sc.count / W))
    const pts: string[] = []
    for (let i = 0; i <= upTo; i += stride) pts.push(`${(i / (sc.count - 1)) * W},${y(sc.prices[i], lo, hi)}`)
    pts.push(`${(upTo / (sc.count - 1)) * W},${y(sc.prices[upTo], lo, hi)}`)
    return pts.join(' ')
  }, [sc, upTo, lo, hi])

  const xAt = (i: number) => (i / (sc.count - 1)) * W

  return (
    <Box border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} aria-hidden="true">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" style={{ display: 'block' }}>
        <polyline points={full} fill="none" stroke={SEMANTIC_COLORS.borderMedium} strokeWidth={1} vectorEffect="non-scaling-stroke" />
        <polyline points={played} fill="none" stroke={SEMANTIC_COLORS.textPrimary} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        {choices.map((c, k) => (
          <line key={`c${k}`} x1={xAt(c.index)} x2={xAt(c.index)} y1={0} y2={H} stroke={SEMANTIC_COLORS.success} strokeWidth={1} vectorEffect="non-scaling-stroke" />
        ))}
        {sales.map((s, k) => (
          <line key={`s${k}`} x1={xAt(s.index)} x2={xAt(s.index)} y1={0} y2={H} stroke={SEMANTIC_COLORS.danger} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        ))}
        <line x1={xAt(upTo)} x2={xAt(upTo)} y1={0} y2={H} stroke={SEMANTIC_COLORS.textTertiary} strokeWidth={1} strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
      </svg>
    </Box>
  )
}

function y(p: number, lo: number, hi: number): number {
  const pad = 6
  return hi > lo ? pad + (1 - (p - lo) / (hi - lo)) * (H - 2 * pad) : H / 2
}
