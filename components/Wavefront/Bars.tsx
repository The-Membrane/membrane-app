import React, { memo } from 'react'
import { Box, Flex, Text, VStack } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'

import { fmtHm, fmtInt } from './format'

const BAR_PITCH = 10
const BAR_WIDTH = 8.4
const BAR_HEIGHT = 54

const labelProps = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: TYPOGRAPHY.label,
  color: SEMANTIC_COLORS.textSecondary,
  sx: { fontVariantNumeric: 'tabular-nums' },
} as const

/**
 * Positions sold per 10 minutes over the last 12 h. Both sides are drawn against the SAME
 * max, so the two columns compare by height. Red: collateral sold (§2), on both sides.
 */
export const Bars: React.FC<{
  values: readonly number[]
  max: number
  fromTs: number
  toTs: number
  /** Right-hand note: the scale ("max 412") or "same scale". */
  note: string
  ariaLabel: string
}> = memo(function Bars({ values, max, fromTs, toTs, note, ariaLabel }) {
  const W = values.length * BAR_PITCH
  return (
    <VStack align="stretch" spacing={SPACING.xs}>
      <Flex justify="space-between" gap={SPACING.sm}>
        <Text {...labelProps}>Positions sold per 10 min · last 12h</Text>
        <Text {...labelProps} flex="none">
          {note}
        </Text>
      </Flex>
      <Box
        role="img"
        aria-label={ariaLabel}
        h={`${BAR_HEIGHT}px`}
        borderBottom="1px solid"
        borderColor={SEMANTIC_COLORS.borderStrong}
      >
        <svg
          width="100%"
          height={BAR_HEIGHT}
          viewBox={`0 0 ${W} ${BAR_HEIGHT}`}
          preserveAspectRatio="none"
          aria-hidden="true"
          focusable="false"
          style={{ display: 'block' }}
        >
          {values.map((v, i) =>
            v > 0 ? (
              <rect
                key={i}
                x={i * BAR_PITCH + (BAR_PITCH - BAR_WIDTH) / 2}
                width={BAR_WIDTH}
                y={BAR_HEIGHT - Math.max(1, Math.round((v / max) * BAR_HEIGHT))}
                height={Math.max(1, Math.round((v / max) * BAR_HEIGHT))}
                style={{ fill: SEMANTIC_COLORS.danger }}
                shapeRendering="crispEdges"
              />
            ) : null,
          )}
        </svg>
      </Box>
      <Flex justify="space-between">
        <Text {...labelProps} color={SEMANTIC_COLORS.textTertiary}>
          {fmtHm(fromTs)}
        </Text>
        <Text {...labelProps} color={SEMANTIC_COLORS.textTertiary}>
          {fmtHm(toTs)} UTC
        </Text>
      </Flex>
    </VStack>
  )
})

export const barsNote = (max: number) => `max ${fmtInt(max)}`
