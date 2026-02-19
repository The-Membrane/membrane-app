/**
 * Spacing System
 *
 * Standardized spacing scale for consistent rhythm and visual hierarchy.
 * Based on Chakra UI's 4px base unit (1 = 0.25rem = 4px).
 *
 * Usage Guidelines:
 * - Use numeric values (not strings) for Chakra props
 * - Avoid inline styles with raw pixel/rem values
 * - Follow the scale for padding, margin, gap, and spacing
 *
 * @example
 * ```tsx
 * import { SPACING } from '@/config/spacing'
 *
 * <VStack spacing={SPACING.md}>
 *   <Box p={SPACING.lg} m={SPACING.sm}>
 *     Content
 *   </Box>
 * </VStack>
 * ```
 */

/**
 * Standardized spacing scale
 *
 * Based on 4px increments (Chakra UI default)
 * 1 unit = 0.25rem = 4px
 */
export const SPACING = {
  /**
   * No spacing - 0px
   * Use for: Removing default spacing, tight layouts
   */
  none: 0,

  /**
   * Extra small - 4px (1 unit)
   * Use for: Minimal separation, tight spacing within components
   */
  xs: 1,

  /**
   * Small - 8px (2 units)
   * Use for: Compact layouts, related items, labels and values
   */
  sm: 2,

  /**
   * Medium small - 12px (3 units)
   * Use for: Moderate separation, form fields, list items
   */
  md: 3,

  /**
   * Medium - 16px (4 units)
   * Use for: Standard separation, cards, sections
   */
  base: 4,

  /**
   * Large - 24px (6 units)
   * Use for: Section separation, content blocks, page titles
   */
  lg: 6,

  /**
   * Extra large - 32px (8 units)
   * Use for: Major sections, page-level spacing
   */
  xl: 8,

  /**
   * 2X Extra large - 48px (12 units)
   * Use for: Hero sections, major page divisions
   */
  '2xl': 12,

  /**
   * 3X Extra large - 64px (16 units)
   * Use for: Large page gaps, major visual breaks
   */
  '3xl': 16,
} as const

/**
 * Type for spacing keys
 */
export type SpacingKey = keyof typeof SPACING

/**
 * Helper function to get spacing value by key
 */
export const getSpacing = (key: SpacingKey): number => {
  return SPACING[key]
}

/**
 * Common spacing patterns for specific use cases
 */
export const SPACING_PATTERNS = {
  /**
   * Card padding
   * Use for: Card, panel, and modal content areas
   */
  cardPadding: SPACING.base, // 16px (4 units)

  /**
   * Section spacing
   * Use for: Space between major sections
   */
  sectionGap: SPACING.lg, // 24px (6 units)

  /**
   * Stack spacing
   * Use for: Default VStack/HStack spacing
   */
  stackSpacing: SPACING.md, // 12px (3 units)

  /**
   * Form field spacing
   * Use for: Space between form inputs
   */
  formFieldGap: SPACING.base, // 16px (4 units)

  /**
   * List item spacing
   * Use for: Space between list items
   */
  listItemGap: SPACING.sm, // 8px (2 units)

  /**
   * Button group spacing
   * Use for: Space between buttons in a group
   */
  buttonGroupGap: SPACING.md, // 12px (3 units)

  /**
   * Modal padding
   * Use for: Modal content padding
   */
  modalPadding: SPACING.lg, // 24px (6 units)

  /**
   * Page padding
   * Use for: Main page container padding
   */
  pagePadding: {
    base: SPACING.base, // Mobile: 16px
    md: SPACING.lg,     // Tablet: 24px
    lg: SPACING.xl,     // Desktop: 32px
  },
} as const

/**
 * Usage guidelines by component type
 */
export const SPACING_GUIDELINES = {
  // Layout components
  VStack: 'Use SPACING.md (3) for default, SPACING.base (4) for more separation',
  HStack: 'Use SPACING.sm (2) for compact, SPACING.md (3) for standard',
  Stack: 'Use SPACING.md (3) for default spacing',

  // Container components
  Box: 'Use SPACING.base (4) for padding, avoid inline styles',
  Card: 'Use SPACING_PATTERNS.cardPadding (4) for consistent card padding',
  Modal: 'Use SPACING_PATTERNS.modalPadding (6) for content area',

  // Form components
  FormControl: 'Use SPACING_PATTERNS.formFieldGap (4) for margin bottom',
  Input: 'Use SPACING.md (3) for margin bottom',
  Button: 'Use SPACING_PATTERNS.buttonGroupGap (3) for button groups',

  // Content components
  Text: 'Use SPACING.sm (2) for margin bottom on paragraphs',
  Heading: 'Use SPACING.base (4) for margin bottom on headings',
  List: 'Use SPACING_PATTERNS.listItemGap (2) for list items',
}

/**
 * Migration helpers for converting from inconsistent values
 */
export const SPACING_MIGRATION = {
  // Map old inconsistent values to standardized ones
  '0.1': SPACING.none,   // Too small, use none
  '0.5': SPACING.xs,     // Round up to xs
  '1.5': SPACING.sm,     // Round to sm
  '3.5': SPACING.base,   // Round to base
  '5': SPACING.lg,       // Map 5 to 6 (lg)
  '7': SPACING.xl,       // Map 7 to 8 (xl)
  '10': SPACING.xl,      // Map 10 to 8 (xl)
  '12': SPACING['2xl'], // Use 2xl scale
  '16': SPACING['3xl'], // Use 3xl scale
}

/**
 * Convert gap string values to Chakra numeric values
 */
export const convertGapToSpacing = (gap: string): number => {
  // Handle percentage values (convert to appropriate numeric)
  if (gap.includes('%')) {
    const percent = parseInt(gap)
    if (percent <= 5) return SPACING.sm
    if (percent <= 15) return SPACING.md
    return SPACING.base
  }

  // Handle rem values
  if (gap.includes('rem')) {
    const rem = parseFloat(gap)
    if (rem <= 0.5) return SPACING.xs
    if (rem <= 1) return SPACING.sm
    if (rem <= 1.5) return SPACING.md
    if (rem <= 2) return SPACING.base
    return SPACING.lg
  }

  // Handle px values
  if (gap.includes('px')) {
    const px = parseInt(gap)
    if (px <= 4) return SPACING.xs
    if (px <= 8) return SPACING.sm
    if (px <= 12) return SPACING.md
    if (px <= 16) return SPACING.base
    if (px <= 24) return SPACING.lg
    return SPACING.xl
  }

  // Handle numeric strings
  const num = parseInt(gap)
  if (isNaN(num)) return SPACING.md // Default fallback
  if (num <= 1) return SPACING.xs
  if (num <= 3) return SPACING.sm
  if (num <= 5) return SPACING.md
  if (num <= 8) return SPACING.base
  return SPACING.lg
}

/**
 * Chakra UI theme extension
 *
 * To use these in Chakra theme:
 * ```tsx
 * import { extendTheme } from '@chakra-ui/react'
 * import { SPACING } from '@/config/spacing'
 *
 * const theme = extendTheme({
 *   space: SPACING,
 * })
 * ```
 */
