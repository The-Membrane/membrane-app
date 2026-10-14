import React from 'react'
import { HStack, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'

import { MARK_TOKEN, markPathD, type MarkKind } from './marks'

/** A legend glyph: the canvas mark itself, as inline SVG. Decorative; the text carries meaning. */
export const Glyph: React.FC<{ kind: MarkKind; size?: number }> = ({ kind, size = 10 }) => {
  const d = markPathD(kind, size)
  const color = MARK_TOKEN[kind]
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
      focusable="false"
      style={{ flex: 'none', overflow: 'visible' }}
    >
      <path d={d} style={{ fill: color }} />
    </svg>
  )
}

/** "<glyph> 2,536 sold": glyph coloured, count in bone, label in muted ink (§2). */
export const LegendItem: React.FC<{ kind: MarkKind; count: string; label: string }> = ({
  kind,
  count,
  label,
}) => (
  <HStack as="span" spacing={SPACING.xs} display="inline-flex" whiteSpace="nowrap">
    <Glyph kind={kind} />
    <Text
      as="span"
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize={TYPOGRAPHY.xs}
      color={SEMANTIC_COLORS.textPrimary}
      sx={{ fontVariantNumeric: 'tabular-nums' }}
    >
      {count}
    </Text>
    <Text
      as="span"
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize={TYPOGRAPHY.xs}
      color={SEMANTIC_COLORS.textSecondary}
    >
      {label}
    </Text>
  </HStack>
)
