import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'

/**
 * Machine-readable numeral inside serif prose (brand rule: data stays mono even
 * when the surrounding sentence is set in the display serif). Ports the proto's
 * `.num` span.
 */
export const Num: React.FC<{ children: React.ReactNode; color?: string }> = ({ children, color }) => (
  <Text
    as="span"
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="0.86em"
    letterSpacing="-0.01em"
    sx={{ fontVariantNumeric: 'tabular-nums' }}
    color={color}
  >
    {children}
  </Text>
)

/** Eyebrow label — mono, 11px, uppercase, tracked, secondary ink (spec rule). */
export const Eyebrow: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Text
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize={TYPOGRAPHY.label}
    textTransform="uppercase"
    letterSpacing="0.28em"
    color={SEMANTIC_COLORS.textSecondary}
  >
    {children}
  </Text>
)

/** Section lede — dim descriptive copy. */
export const Lede: React.FC<{ children: React.ReactNode; maxW?: string }> = ({ children, maxW = '74ch' }) => (
  <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textSecondary} maxW={maxW}>
    {children}
  </Text>
)

/** Section heading — eyebrow over a display-serif h2. */
export const SectionHead: React.FC<{ eyebrow: string; title: string; lede?: React.ReactNode }> = ({
  eyebrow,
  title,
  lede,
}) => (
  <Box display="grid" gap={SPACING.sm}>
    <Eyebrow>{eyebrow}</Eyebrow>
    <Text
      as="h2"
      fontFamily={TYPOGRAPHY.fontDisplay}
      fontWeight={TYPOGRAPHY.normal}
      fontSize={{ base: '21px', md: '30px' }}
      lineHeight="1.15"
      color={SEMANTIC_COLORS.textPrimary}
      sx={{ textWrap: 'balance' }}
    >
      {title}
    </Text>
    {lede}
  </Box>
)

/** Numbers-in-a-serif heading: composes a serif line with mono `Num` inserts. */
export const SerifLine: React.FC<{ children: React.ReactNode; size?: object | string; color?: string }> = ({
  children,
  size = { base: '17px', md: '23px' },
  color = SEMANTIC_COLORS.textPrimary,
}) => (
  <Text as="p" fontFamily={TYPOGRAPHY.fontDisplay} fontSize={size} lineHeight="1.3" color={color}>
    {children}
  </Text>
)
