import React from 'react'
import { Box, Progress, Stack, Text, ProgressProps } from '@chakra-ui/react'
import { SEMANTIC_COLORS } from '@/config/semanticColors'

export interface ProgressBarProps extends Omit<ProgressProps, 'value'> {
  /**
   * Current value (e.g., current deposits)
   */
  value: number

  /**
   * Maximum value (e.g., deposit cap)
   */
  maxValue: number

  /**
   * Show label with value/maxValue
   * @default true
   */
  showLabel?: boolean

  /**
   * Size variant
   * @default 'md'
   */
  size?: 'sm' | 'md' | 'lg'

  /**
   * Format function for displaying values
   * @default (val) => val.toString()
   */
  formatValue?: (value: number) => string

  /**
   * Custom color scheme (overrides adaptive coloring)
   */
  colorScheme?: string
}

/**
 * Adaptive color logic (Living Typeface semantic ramp):
 * - 100%+:  blood  (#cf4034) — at/over cap
 * - 85-99%: gold   (#d8b24a) — approaching cap
 * - 70-84%: gold-dim         — moderate usage
 * - 0-69%:  phosphor (#9bdc4f) — healthy / plenty of room
 */
const getColor = (percent: number): string => {
  if (percent >= 100) return SEMANTIC_COLORS.danger
  if (percent >= 85) return SEMANTIC_COLORS.warning
  if (percent >= 70) return '#c19a3a' // bespoke gold-dim, no token
  return SEMANTIC_COLORS.success
}

/**
 * Standardized ProgressBar Component
 *
 * Features:
 * - Adaptive coloring based on usage percentage
 * - Consistent sizing and styling
 * - Optional value labels
 * - Custom formatting support
 *
 * @example
 * ```tsx
 * // Basic usage
 * <ProgressBar value={75} maxValue={100} />
 *
 * // With custom formatting
 * <ProgressBar
 *   value={750000}
 *   maxValue={1000000}
 *   formatValue={(v) => `$${(v / 1000000).toFixed(2)}M`}
 * />
 *
 * // Small size without label
 * <ProgressBar
 *   value={50}
 *   maxValue={100}
 *   size="sm"
 *   showLabel={false}
 * />
 * ```
 */
// Height mapping
const heights = {
  sm: '4px',
  md: '6px',
  lg: '8px',
}

export const ProgressBar: React.FC<ProgressBarProps> = ({
  value,
  maxValue,
  showLabel = true,
  size = 'md',
  formatValue,
  colorScheme,
  ...props
}) => {
  // Calculate usage percentage
  const usagePercent = maxValue > 0 ? (value / maxValue) * 100 : 0
  const cappedPercent = Math.min(usagePercent, 100)

  // Format display values
  const displayValue = formatValue ? formatValue(value) : value.toString()
  const displayMax = formatValue ? formatValue(maxValue) : maxValue.toString()

  return (
    <Stack spacing={1}>
      {showLabel && (
        <Text fontSize="sm" color={SEMANTIC_COLORS.textPrimary} fontWeight="medium">
          {displayValue} / {displayMax}
        </Text>
      )}
      <Box position="relative">
        {/* Background track */}
        <Box
          position="absolute"
          top={0}
          left={0}
          right={0}
          height={heights[size]}
          bg="color-mix(in srgb, var(--m-text-primary) 6%, transparent)"
          borderRadius="3px"
        />
        {/* Progress fill */}
        <Progress
          value={cappedPercent}
          height={heights[size]}
          colorScheme={colorScheme || 'primary'}
          bg="transparent"
          borderRadius="3px"
          sx={{
            '& > div': {
              backgroundColor: colorScheme
                ? undefined
                : getColor(usagePercent),
            }
          }}
          {...props}
        />
      </Box>
    </Stack>
  )
}

export default ProgressBar
