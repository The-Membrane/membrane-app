/**
 * Typography System
 *
 * Standardized typography scale for the Membrane app.
 * Use these constants instead of arbitrary font sizes.
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

  // Labels (typically uppercase with letter-spacing)
  label: '11px', // Form labels, table headers

  // Font weights
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
    color: 'white',
    mb: 6,
  },
  sectionTitle: {
    fontSize: TYPOGRAPHY.h2,
    fontWeight: TYPOGRAPHY.semibold,
    color: 'white',
    mb: 4,
  },
  modalTitle: {
    fontSize: TYPOGRAPHY.h3,
    fontWeight: TYPOGRAPHY.bold,
    color: 'white',
    mb: 4,
  },
  cardTitle: {
    fontSize: TYPOGRAPHY.h4,
    fontWeight: TYPOGRAPHY.semibold,
    color: 'white',
    mb: 2,
  },
  tableHeader: {
    fontSize: TYPOGRAPHY.label,
    fontWeight: TYPOGRAPHY.normal,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.1em',
    color: 'rgba(160, 160, 160, 1)',
  },
  body: {
    fontSize: TYPOGRAPHY.body,
    fontWeight: TYPOGRAPHY.normal,
    color: 'white',
  },
  bodySecondary: {
    fontSize: TYPOGRAPHY.small,
    fontWeight: TYPOGRAPHY.normal,
    color: 'rgba(255, 255, 255, 0.6)',
  },
  bodyTertiary: {
    fontSize: TYPOGRAPHY.xs,
    fontWeight: TYPOGRAPHY.normal,
    color: 'rgba(255, 255, 255, 0.4)',
  },
} as const

/**
 * Helper function to get consistent text props
 */
export const getTextStyle = (style: keyof typeof TEXT_STYLES) => TEXT_STYLES[style]
