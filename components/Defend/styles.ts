import { ButtonProps } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'

// Living-Typeface button presets (color/border motion only, sharp corners).

/** Solid gold primary CTA (proto `.cta`). */
export const ctaGold: ButtonProps = {
  bg: SEMANTIC_COLORS.warning,
  color: SEMANTIC_COLORS.bgPrimary,
  border: '1px solid',
  borderColor: SEMANTIC_COLORS.warning,
  borderRadius: 0,
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: TYPOGRAPHY.label,
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  px: SPACING.lg,
  py: SPACING.md,
  h: 'auto',
  transition: TRANSITIONS.colors,
  _hover: { bg: SEMANTIC_COLORS.warning },
}

/** Ghost/hairline secondary CTA (proto `.xbtn`). */
export const ctaGhost: ButtonProps = {
  bg: 'transparent',
  color: SEMANTIC_COLORS.textPrimary,
  border: '1px solid',
  borderColor: SEMANTIC_COLORS.borderStrong,
  borderRadius: 0,
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: TYPOGRAPHY.label,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  px: SPACING.md,
  py: SPACING.sm,
  h: 'auto',
  transition: TRANSITIONS.colors,
  _hover: { color: SEMANTIC_COLORS.success, borderColor: SEMANTIC_COLORS.success },
}

/** Solid phosphor go CTA (proto `.xbtn.go`). */
export const ctaGo: ButtonProps = {
  ...ctaGhost,
  bg: SEMANTIC_COLORS.success,
  color: SEMANTIC_COLORS.bgPrimary,
  borderColor: SEMANTIC_COLORS.success,
  _hover: { bg: SEMANTIC_COLORS.success },
}
