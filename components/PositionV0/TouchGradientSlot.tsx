// THE SLOT for the touch-gradient visual. The final drawing (ink-density halftone per
// DESIGN_RULES §4) comes from a design spec that is not yet published for this page, so
// today the slot draws a thin ink bar on the shared 0–100% axis and nothing else: no
// colour, no halftone.
//
// THE DATA CONTRACT is the swap point. Whatever replaces the bar receives exactly these
// props, one row per horizon, on one shared axis owned by the parent (HistorySurface):
//   horizon, pct (0–100, unrounded), touched, n, period {from, to}, confidence.
// `confidence` is typed for the Q26 labels (HIGH / MEDIUM / LOW / insufficient / STALE)
// and is always null today; null renders nothing.

import React from 'react'
import { Box } from '@chakra-ui/react'

import { NEWS } from '@/components/NewsEdition/tokens'
import type { HistoryConfidence } from '@/lib/position/touch'
import type { HorizonId } from '@/lib/position/touchHistory'

export interface TouchGradientSlotProps {
  horizon: HorizonId
  /** touched / n × 100, unrounded. */
  pct: number
  touched: number
  n: number
  period: { from: string; to: string }
  confidence: HistoryConfidence | null
}

export const TouchGradientSlot: React.FC<TouchGradientSlotProps> = ({ pct }) => {
  const w = Math.max(0, Math.min(100, pct))
  return (
    <Box position="relative" h="14px" minW={0} aria-hidden="true">
      {/* The shared axis: a hairline track from 0 to 100%. */}
      <Box position="absolute" left={0} right={0} top="50%" borderTop={`1px solid ${NEWS.rule}`} />
      {/* The value: a thin ink bar from 0, ending in a tick so a value near 0 still shows. */}
      <Box position="absolute" left={0} top="calc(50% - 1px)" h="2px" w={`${w}%`} bg={NEWS.ink} />
      <Box position="absolute" left={`calc(${w}% - 0.5px)`} top="1px" bottom="1px" w="1px" bg={NEWS.ink} />
    </Box>
  )
}
