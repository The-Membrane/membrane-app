// Newspaper grammar for the landing at `/`, on the simulator's Living Typeface tokens:
// kicker → headline → deck, hairline rules instead of boxes, mono credits, one caps
// tracking value. DESIGN_RULES §1/§6 (membrane-board design/DESIGN_RULES.md).

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

/** One caps tracking value for the whole page (DESIGN_RULES §1). */
export const CAPS = '0.12em'

export const kicker = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: TYPOGRAPHY.label,
  letterSpacing: CAPS,
  textTransform: 'uppercase' as const,
  color: SEMANTIC_COLORS.textSecondary,
}

export const sectionHead = {
  fontFamily: TYPOGRAPHY.fontDisplay,
  fontSize: { base: '22px', md: '28px' },
  lineHeight: 1.15,
  color: SEMANTIC_COLORS.textPrimary,
}

export const deck = {
  fontFamily: TYPOGRAPHY.fontDisplay,
  fontStyle: 'italic' as const,
  fontSize: { base: '17px', md: '19px' },
  lineHeight: 1.4,
  color: SEMANTIC_COLORS.textSecondary,
}

export const body = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: '13px',
  lineHeight: 1.65,
  color: SEMANTIC_COLORS.textPrimary,
}

export const small = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: '11px',
  lineHeight: 1.6,
  color: SEMANTIC_COLORS.textSecondary,
}

export const credit = {
  ...small,
  color: SEMANTIC_COLORS.textTertiary,
  textAlign: 'right' as const,
}

export const tabularNums = { sx: { fontVariantNumeric: 'tabular-nums' } }

export const rule = `1px solid ${SEMANTIC_COLORS.borderSubtle}`
export const ruleStrong = `1px solid ${SEMANTIC_COLORS.borderStrong}`
