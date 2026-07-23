/**
 * Typography System — Living Typeface
 *
 * Standardized typography scale for the Membrane app.
 * Use these constants instead of arbitrary font sizes.
 *
 * FONT FAMILIES (set globally in the Chakra theme, see theme/fonts.ts):
 * - Display + headings: 'Redaction', Georgia, serif (weight 400; italic for
 *   editorial/sub copy). This is the heading font in the theme.
 * - Body UI + ALL numbers/data: 'JetBrains Mono', ui-monospace, monospace.
 *   This is BOTH the theme `body` and `mono` font — numbers must stay
 *   machine-readable.
 * - Labels: mono, 10–11px, uppercase, letter-spacing ~.2em.
 *
 * Redaction weights are effectively 400 only (the 10/35/50/70/100 variants are
 * increasing pixelation, DISPLAY ONLY — not a numeric weight axis). For UI weight
 * emphasis, lean on JetBrains Mono weights (400/500/700) below.
 *
 * @example
 * ```tsx
 * import { TYPOGRAPHY } from '@/helpers/typography'
 *
 * <Text fontSize={TYPOGRAPHY.h1} fontWeight={TYPOGRAPHY.bold}>
 *   Page Title
 * </Text>
 * ```
 */

export const TYPOGRAPHY = {
  // Headings
  h1: '32px',    // Page titles
  h2: '24px',    // Section titles
  h3: '18px',    // Subsection titles
  h4: '16px',    // Card titles

  // Body text
  body: '16px',  // Primary text content
  small: '14px', // Secondary text, descriptions
  xs: '12px',    // Tertiary text, timestamps

  // Labels (mono, uppercase, letter-spaced ~.2em)
  label: '11px', // Form labels, table headers

  // Font weights (map to JetBrains Mono 400/500/700; 'bold' rounds to 700).
  bold: 700,
  semibold: 600,
  medium: 500,
  normal: 400,
} as const

/**
 * Text style presets for common use cases
 */
export const TEXT_STYLES = {
  pageTitle: {
    fontSize: TYPOGRAPHY.h1,
    fontWeight: TYPOGRAPHY.bold,
    color: '#ece6d8',
    mb: 6,
  },
  sectionTitle: {
    fontSize: TYPOGRAPHY.h2,
    fontWeight: TYPOGRAPHY.semibold,
    color: '#ece6d8',
    mb: 4,
  },
  modalTitle: {
    fontSize: TYPOGRAPHY.h3,
    fontWeight: TYPOGRAPHY.bold,
    color: '#ece6d8',
    mb: 4,
  },
  cardTitle: {
    fontSize: TYPOGRAPHY.h4,
    fontWeight: TYPOGRAPHY.semibold,
    color: '#ece6d8',
    mb: 2,
  },
  tableHeader: {
    fontSize: TYPOGRAPHY.label,
    fontWeight: TYPOGRAPHY.normal,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.2em',
    color: '#8d877b',
  },
  body: {
    fontSize: TYPOGRAPHY.body,
    fontWeight: TYPOGRAPHY.normal,
    color: '#ece6d8',
  },
  bodySecondary: {
    fontSize: TYPOGRAPHY.small,
    fontWeight: TYPOGRAPHY.normal,
    color: '#8d877b',
  },
  bodyTertiary: {
    fontSize: TYPOGRAPHY.xs,
    fontWeight: TYPOGRAPHY.normal,
    color: '#56524a',
  },
} as const

/**
 * Helper function to get consistent text props
 */
export const getTextStyle = (style: keyof typeof TEXT_STYLES) => TEXT_STYLES[style]
