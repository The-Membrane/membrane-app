import React, { memo } from 'react'
import { Box, VStack } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'

import { fmtHm, fmtInt } from './format'

const BAR_PITCH = 10
const BAR_WIDTH = 8.4
/** Bar area height, px: shorter on phones (the page stacks two of them). */
const BAR_HEIGHT = 54
const BAR_HEIGHT_PHONE = 32

// Per-frame text: plain elements with token styles (no style recomputation per frame).
const label: React.CSSProperties = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: TYPOGRAPHY.label,
  color: SEMANTIC_COLORS.textSecondary,
  fontVariantNumeric: 'tabular-nums',
}
const tick: React.CSSProperties = { ...label, color: SEMANTIC_COLORS.textTertiary }
const row: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 'var(--chakra-space-2)',
}

/**
 * Positions sold per 10 minutes over the last 12 h. Both sides are drawn against the SAME
 * max, so the two columns compare by height. Red: collateral sold (§2), on both sides.
 */
export const Bars: React.FC<{
  values: readonly number[]
  max: number
  fromTs: number
  toTs: number
  /** Left caption ('' for none: the other side's caption says it). */
  caption: string
  /** Right-hand note: the scale ("max 412") or "same scale". */
  note: string
  ariaLabel: string
}> = memo(function Bars({ values, max, fromTs, toTs, caption, note, ariaLabel }) {
  const W = values.length * BAR_PITCH
  const scale = Math.max(1, max)
  return (
    <VStack align="stretch" spacing={SPACING.xs}>
      <div style={row}>
        <span style={label}>{caption || '\u00a0'}</span>
        <span style={{ ...label, flex: 'none' }}>{note}</span>
      </div>
      <Box
        role="img"
        aria-label={ariaLabel}
        h={{ base: `${BAR_HEIGHT_PHONE}px`, sm: `${BAR_HEIGHT}px` }}
        borderBottom="1px solid"
        borderColor={SEMANTIC_COLORS.borderStrong}
      >
        <svg
          width="100%"
          height="100%"
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
                y={BAR_HEIGHT - Math.max(1, Math.round((v / scale) * BAR_HEIGHT))}
                height={Math.max(1, Math.round((v / scale) * BAR_HEIGHT))}
                style={{ fill: SEMANTIC_COLORS.danger }}
                shapeRendering="crispEdges"
              />
            ) : null,
          )}
        </svg>
      </Box>
      <div style={row}>
        <span style={tick}>{fmtHm(fromTs)}</span>
        <span style={tick}>{fmtHm(toTs)}</span>
      </div>
    </VStack>
  )
})

/** The shared scale, or nothing while there is nothing to scale. */
export const barsNote = (max: number) => (max > 0 ? `max ${fmtInt(max)}` : '')
