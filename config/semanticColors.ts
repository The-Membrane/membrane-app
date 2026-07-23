/**
 * Semantic Color System
 *
 * Standardized color tokens for consistent use across the application.
 * These colors convey meaning and state, making the UI more intuitive.
 *
 * @example
 * ```tsx
 * import { SEMANTIC_COLORS } from '@/config/semanticColors'
 *
 * <Text color={SEMANTIC_COLORS.textSecondary}>
 *   Secondary text
 * </Text>
 *
 * <Button
 *   bg={SEMANTIC_COLORS.primary}
 *   borderColor={SEMANTIC_COLORS.borderMedium}
 * >
 *   Primary Action
 * </Button>
 * ```
 */

/**
 * Semantic color tokens for the Membrane application
 */
export const SEMANTIC_COLORS = {
  // ============================================
  // STATE COLORS
  // ============================================
  // Living Typeface: phosphor = up/healthy, blood = down/danger,
  // gold = gates/warnings, cyber teal = machine/info.

  /**
   * Success state - positive outcomes, confirmations
   * Used for: Success messages, positive metrics, completion states
   */
  success: '#9bdc4f', // Phosphor green

  /**
   * Warning state - caution, approaching limits
   * Used for: Warnings, capacity warnings, attention needed
   */
  warning: '#d8b24a', // Gold

  /**
   * Danger state - errors, critical issues, destructive actions
   * Used for: Error messages, liquidation warnings, delete actions
   */
  danger: '#cf4034', // Blood red

  /**
   * Info state - informational, neutral information
   * Used for: Info messages, tooltips, helper text
   */
  info: '#46d39a', // Cyber teal

  // ============================================
  // EMPHASIS COLORS
  // ============================================

  /**
   * Primary action color - main CTAs, important actions
   * Used for: Primary buttons, important links, key actions
   */
  primary: '#9bdc4f', // Phosphor green

  /**
   * Secondary action color - supporting actions
   * Used for: Secondary buttons, alternative actions
   */
  secondary: '#46d39a', // Cyber teal

  // ============================================
  // TEXT COLORS
  // ============================================
  // Warm bone ink, NOT white.

  /**
   * Primary text - main content, headings
   * High contrast for readability
   */
  textPrimary: '#ece6d8',

  /**
   * Secondary text - supporting content, descriptions
   * Medium contrast
   */
  textSecondary: '#8d877b',

  /**
   * Tertiary text - timestamps, metadata, least important text
   * Lower contrast
   */
  textTertiary: '#56524a',

  // ============================================
  // BACKGROUND COLORS
  // ============================================
  // Near-black, NOT navy.

  /**
   * Primary background - main app background
   */
  bgPrimary: '#09090a',

  /**
   * Secondary background - cards, panels, elevated surfaces
   */
  bgSecondary: '#0e0d10', // Card

  /**
   * Tertiary background - nested elements, subtle elevation
   */
  bgTertiary: '#100f12', // Raised

  // ============================================
  // BORDER COLORS
  // ============================================
  // Bone hairlines.

  /**
   * Subtle borders - barely visible, gentle separation
   */
  borderSubtle: 'rgba(236, 230, 216, 0.10)',

  /**
   * Medium borders - standard borders, clear separation
   */
  borderMedium: 'rgba(236, 230, 216, 0.10)',

  /**
   * Strong borders - emphasized borders, focus states
   */
  borderStrong: 'rgba(236, 230, 216, 0.22)',
} as const

/**
 * Type for semantic color keys
 */
export type SemanticColorKey = keyof typeof SEMANTIC_COLORS

/**
 * Helper function to get semantic color by key
 */
export const getSemanticColor = (key: SemanticColorKey): string => {
  return SEMANTIC_COLORS[key]
}

/**
 * Color usage guidelines
 */
export const COLOR_USAGE_GUIDELINES = {
  // State colors
  success: [
    'Transaction confirmations',
    'Successful operations',
    'Positive metrics (APY gains)',
    'Health ratio in safe zone',
  ],
  warning: [
    'Approaching supply caps',
    'High utilization warnings',
    'Caution states',
    'Recommended actions needed',
  ],
  danger: [
    'Error messages',
    'Liquidation warnings',
    'Critical health ratios',
    'Destructive actions (delete, remove)',
    'Failed transactions',
  ],
  info: [
    'Informational tooltips',
    'Helper text',
    'Neutral notifications',
    'Educational content',
  ],

  // Emphasis colors
  primary: [
    'Main call-to-action buttons',
    'Primary navigation active states',
    'Important interactive elements',
    'Key conversion points',
  ],
  secondary: [
    'Secondary action buttons',
    'Alternative paths',
    'Supporting actions',
    'Repeated CTAs (ghost buttons)',
  ],

  // Text colors
  textPrimary: [
    'Page titles',
    'Card titles',
    'Main content',
    'Important labels',
  ],
  textSecondary: [
    'Descriptions',
    'Supporting text',
    'Subtitles',
    'Helper text',
  ],
  textTertiary: [
    'Timestamps',
    'Metadata',
    'Least important information',
    'Disabled text',
  ],

  // Background colors
  bgPrimary: [
    'Main app background',
    'Page backgrounds',
  ],
  bgSecondary: [
    'Card backgrounds',
    'Panel backgrounds',
    'Modal backgrounds',
    'Elevated surfaces',
  ],
  bgTertiary: [
    'Nested card backgrounds',
    'Table row hovers',
    'Subtle elevation',
  ],

  // Border colors
  borderSubtle: [
    'Dividers',
    'Section separators',
    'Subtle boundaries',
  ],
  borderMedium: [
    'Card borders',
    'Input borders',
    'Standard borders',
  ],
  borderStrong: [
    'Focus states',
    'Active borders',
    'Emphasized boundaries',
    'Selected states',
  ],
}

/**
 * Chakra UI theme extension
 *
 * To use these colors in Chakra theme:
 * ```tsx
 * import { extendTheme } from '@chakra-ui/react'
 * import { SEMANTIC_COLORS } from '@/config/semanticColors'
 *
 * const theme = extendTheme({
 *   colors: {
 *     semantic: SEMANTIC_COLORS,
 *   },
 * })
 * ```
 *
 * Then use as: <Box bg="semantic.bgSecondary" />
 */
