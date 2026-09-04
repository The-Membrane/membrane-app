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
 *
 * Values are CSS custom properties defined per-theme in styles/themes.css
 * (dark = Living Typeface, light = Parchment; [data-theme] on <html>).
 * They pass straight through Chakra style props and plain CSS.
 *
 * They do NOT resolve in non-CSS contexts (Canvas 2D fillStyle, color-math
 * libraries, anything that parses hex). There, resolve first:
 * `resolveColor(SEMANTIC_COLORS.danger)` from helpers/resolveToken.ts.
 */
export const SEMANTIC_COLORS = {
  // ============================================
  // STATE COLORS
  // ============================================
  // Living Typeface: phosphor = up/healthy, blood = down/danger,
  // gold = gates/warnings, cyber teal = machine/info.
  // Parchment swaps in darker twins that hold WCAG contrast on cream.

  /**
   * Success state - positive outcomes, confirmations
   * Used for: Success messages, positive metrics, completion states
   */
  success: 'var(--m-success)', // Phosphor green / moss

  /**
   * Warning state - caution, approaching limits
   * Used for: Warnings, capacity warnings, attention needed
   */
  warning: 'var(--m-warning)', // Gold / dark gold

  /**
   * Danger state - errors, critical issues, destructive actions
   * Used for: Error messages, liquidation warnings, delete actions
   */
  danger: 'var(--m-danger)', // Blood red / deep blood

  /**
   * Info state - informational, neutral information
   * Used for: Info messages, tooltips, helper text
   */
  info: 'var(--m-info)', // Cyber teal / deep teal

  // ============================================
  // EMPHASIS COLORS
  // ============================================

  /**
   * Primary action color - main CTAs, important actions
   * Used for: Primary buttons, important links, key actions
   */
  primary: 'var(--m-primary)', // Phosphor green / moss

  /**
   * Secondary action color - supporting actions
   * Used for: Secondary buttons, alternative actions
   */
  secondary: 'var(--m-secondary)', // Cyber teal / deep teal

  // ============================================
  // TEXT COLORS
  // ============================================
  // Warm bone ink on dark, espresso ink on parchment. NOT white, NOT gray.

  /**
   * Primary text - main content, headings
   * High contrast for readability
   */
  textPrimary: 'var(--m-text-primary)',

  /**
   * Secondary text - supporting content, descriptions
   * Medium contrast
   */
  textSecondary: 'var(--m-text-secondary)',

  /**
   * Tertiary text - timestamps, metadata, least important text
   * Lower contrast
   */
  textTertiary: 'var(--m-text-tertiary)',

  // ============================================
  // BACKGROUND COLORS
  // ============================================
  // Near-black / warm parchment. NOT navy, NOT pure white.

  /**
   * Primary background - main app background
   */
  bgPrimary: 'var(--m-bg-primary)',

  /**
   * Secondary background - cards, panels, elevated surfaces
   */
  bgSecondary: 'var(--m-bg-secondary)', // Card

  /**
   * Tertiary background - nested elements, subtle elevation
   */
  bgTertiary: 'var(--m-bg-tertiary)', // Raised

  // ============================================
  // BORDER COLORS
  // ============================================
  // Bone hairlines on dark, espresso hairlines on parchment.

  /**
   * Subtle borders - barely visible, gentle separation
   */
  borderSubtle: 'var(--m-border-subtle)',

  /**
   * Medium borders - standard borders, clear separation
   */
  borderMedium: 'var(--m-border-medium)',

  /**
   * Strong borders - emphasized borders, focus states
   */
  borderStrong: 'var(--m-border-strong)',
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
