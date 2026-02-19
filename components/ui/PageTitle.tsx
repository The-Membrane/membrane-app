import React from 'react'
import { Text, TextProps, VStack } from '@chakra-ui/react'
import { TYPOGRAPHY } from '@/helpers/typography'

export interface PageTitleProps extends Omit<TextProps, 'title'> {
  /**
   * The title text to display
   */
  title: string

  /**
   * Optional subtitle text
   */
  subtitle?: string

  /**
   * Style variant
   * @default 'standard'
   */
  variant?: 'standard' | 'cyberpunk'

  /**
   * Optional gradient for text
   * Example: "linear(to-r, purple.400, blue.400, magenta.400)"
   */
  gradient?: string

  /**
   * Optional subtitle color
   * @default 'gray.400'
   */
  subtitleColor?: string
}

/**
 * PageTitle Component
 *
 * Standardized page title with consistent styling across the application.
 * Supports both standard and cyberpunk variants.
 *
 * @example
 * ```tsx
 * // Standard title
 * <PageTitle title="Portfolio" />
 *
 * // Cyberpunk styled title with subtitle
 * <PageTitle
 *   title="BOOSTS"
 *   subtitle="Manage your deposit boost sources"
 *   variant="cyberpunk"
 * />
 *
 * // With custom overrides
 * <PageTitle
 *   title="Custom Title"
 *   mb={12}
 *   textAlign="center"
 * />
 *
 * // With gradient
 * <PageTitle
 *   title="VISUALIZATION"
 *   gradient="linear(to-r, purple.400, blue.400)"
 *   variant="cyberpunk"
 * />
 * ```
 */
export const PageTitle: React.FC<PageTitleProps> = ({
  title,
  subtitle,
  variant = 'standard',
  gradient,
  subtitleColor = 'gray.400',
  ...props
}) => {
  const baseStyles: TextProps = {
    fontSize: TYPOGRAPHY.h1,
    fontWeight: TYPOGRAPHY.bold,
    color: gradient ? undefined : 'white',
    mb: subtitle ? 2 : 6,
    ...(gradient ? { bgGradient: gradient, bgClip: 'text' } : {}),
  }

  const variantStyles: Record<'standard' | 'cyberpunk', TextProps> = {
    standard: {
      ...baseStyles,
    },
    cyberpunk: {
      ...baseStyles,
      fontFamily: 'mono',
      textTransform: 'uppercase',
      letterSpacing: 'wide',
    },
  }

  const titleStyles = { ...variantStyles[variant], ...props }

  if (subtitle) {
    return (
      <VStack align="flex-start" spacing={1} mb={6}>
        <Text {...titleStyles}>{title}</Text>
        <Text
          fontSize="sm"
          color={subtitleColor}
          fontFamily={variant === 'cyberpunk' ? 'mono' : undefined}
        >
          {subtitle}
        </Text>
      </VStack>
    )
  }

  return <Text {...titleStyles}>{title}</Text>
}

export default PageTitle
