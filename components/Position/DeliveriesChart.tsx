import React, { useEffect, useRef, useState } from 'react'
import { Box, HStack, Text } from '@chakra-ui/react'

import { Card } from '@/components/ui/Card'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'

import { MockStamp } from '@/components/demo'

import { Eyebrow } from './primitives'
import { BENCH_SOLD, SERIES } from './fixtures'
import { drawChart, withAlpha } from './utils'
import { BenchMode, ChartRange } from './types'

const RANGES: { r: ChartRange; label: string }[] = [
  { r: 'life', label: 'Lifetime' },
  { r: '90d', label: '90 days' },
  { r: '30d', label: '30 days' },
]
const BENCHES: { b: Exclude<BenchMode, null>; label: string }[] = [
  { b: 'hold', label: 'vs holding' },
  { b: 'sold', label: 'vs sold in Jan' },
]

const Chip: React.FC<{ on: boolean; onClick: () => void; children: React.ReactNode }> = ({ on, onClick, children }) => (
  <Box
    as="button"
    type="button"
    onClick={onClick}
    bg="transparent"
    border="1px solid"
    borderColor={on ? SEMANTIC_COLORS.borderStrong : 'transparent'}
    color={on ? SEMANTIC_COLORS.textPrimary : SEMANTIC_COLORS.textTertiary}
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="9.5px"
    letterSpacing="0.16em"
    textTransform="uppercase"
    p="5px 9px"
    cursor="pointer"
    transition={TRANSITIONS.colors}
    _hover={{ color: SEMANTIC_COLORS.success }}
    _focus={FOCUS_STYLES.ring}
  >
    {children}
  </Box>
)

/** Section 1.5 — cumulative delivered chart with range + benchmark toggles. */
export const DeliveriesChart: React.FC = () => {
  const [range, setRange] = useState<ChartRange>('life')
  const [bench, setBench] = useState<BenchMode>('hold')
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    const canvas = canvasRef.current
    if (!host || !canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const paint = () => {
      const w = host.clientWidth
      const h = host.clientHeight
      if (!w || !h) return
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      drawChart(ctx, w, h, SERIES[range], bench, BENCH_SOLD[range])
    }

    paint()
    window.addEventListener('resize', paint)
    return () => window.removeEventListener('resize', paint)
  }, [range, bench])

  const grid = withAlpha(SEMANTIC_COLORS.textPrimary, 0.045)

  return (
    <Card mt={SPACING.base} id="chartCard">
      <HStack justify="space-between" align="baseline" spacing={SPACING.md} flexWrap="wrap">
        <Eyebrow>
          Delivered, cumulative <MockStamp />
        </Eyebrow>
        <HStack spacing="2px">
          {RANGES.map(({ r, label }) => (
            <Chip key={r} on={range === r} onClick={() => setRange(r)}>
              {label}
            </Chip>
          ))}
        </HStack>
        <HStack spacing="2px" aria-label="Benchmark">
          {BENCHES.map(({ b, label }) => (
            <Chip key={b} on={bench === b} onClick={() => setBench((prev) => (prev === b ? null : b))}>
              {label}
            </Chip>
          ))}
        </HStack>
      </HStack>

      <Box
        ref={hostRef}
        position="relative"
        h="190px"
        mt={SPACING.md}
        bg={SEMANTIC_COLORS.bgPrimary}
        border="1px solid"
        borderColor={SEMANTIC_COLORS.borderSubtle}
        backgroundImage={`repeating-linear-gradient(0deg, ${grid} 0 1px, transparent 1px 24px), repeating-linear-gradient(90deg, ${grid} 0 1px, transparent 1px 24px)`}
      >
        <Box as="canvas" ref={canvasRef} position="absolute" inset={0} w="100%" h="100%" />
      </Box>

      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9.5px" color={SEMANTIC_COLORS.textTertiary} lineHeight={1.5} m="8px 0 0">
        Every point is a settled delivery — the line can plateau, and does: the flat week in June is the sUSDe
        cooldown, when nothing arrived. Measured on-chain; last event 2h ago. Benchmarks: holding alone delivers
        $0 — the whole green line is the surplus; the sold-in-January path is cash interest on the proceeds, net
        of exit cost and tax.
      </Text>
    </Card>
  )
}
