import React from 'react'
import { Box, Progress, Stack, Text, ProgressProps } from '@chakra-ui/react'

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

  /**
   * Adaptive color logic:
   * - 100%+: Red (at/over cap)
   * - 85-99%: Dark cyan (approaching cap)
   * - 70-84%: Medium cyan (moderate usage)
   * - 50-69%: Standard cyan
   * - 0-49%: Light cyan (plenty of room)
   */
  const getColor = (percent: number): string => {
    if (percent >= 100) return 'red.400'
    if (percent >= 85) return 'cyan.700'
    if (percent >= 70) return 'cyan.600'
    if (percent >= 50) return 'cyan.500'
    return 'cyan.400'
  }

  // Height mapping
  const heights = {
    sm: '4px',
    md: '6px',
    lg: '8px',
  }

  // Format display values
  const displayValue = formatValue ? formatValue(value) : value.toString()
  const displayMax = formatValue ? formatValue(maxValue) : maxValue.toString()

  return (
    <Stack spacing={1}>
      {showLabel && (
        <Text fontSize="sm" color="white" fontWeight="medium">
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
          bg="rgba(255, 255, 255, 0.05)"
          borderRadius="3px"
        />
        {/* Progress fill */}
        <Progress
          value={cappedPercent}
          height={heights[size]}
          colorScheme={colorScheme || 'cyan'}
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
