import React from 'react'
import { Box, BoxProps } from '@chakra-ui/react'
import { TRANSITIONS, HOVER_EFFECTS } from '@/config/transitions'

export interface CardProps extends BoxProps {
  /**
   * Visual variant of the card
   * - default: Standard card styling
   * - elevated: Card with shadow for emphasis
   * - subtle: Lower contrast for secondary content
   */
  variant?: 'default' | 'elevated' | 'subtle'

  /**
   * Whether the card is interactive (clickable)
   * Adds hover effects and cursor pointer
   */
  interactive?: boolean
}

/**
 * Standardized Card Component
 *
 * Provides consistent styling across all card-based UI elements.
 * Use this instead of Box with inline card styling.
 *
 * @example
 * ```tsx
 * // Static card
 * <Card variant="default">
 *   <Text>Card content</Text>
 * </Card>
 *
 * // Interactive card with hover effects
 * <Card variant="elevated" interactive onClick={handleClick}>
 *   <Text>Click me!</Text>
 * </Card>
 * ```
 */
export const Card: React.FC<CardProps> = ({
  children,
  variant = 'default',
  interactive = false,
  ...props
}) => {
  const variants = {
    default: {
      bg: 'rgba(10, 10, 10, 0.8)',
      borderRadius: '24px',
      p: 6,
      border: '1px solid',
      borderColor: 'rgba(255, 255, 255, 0.2)',
    },
    elevated: {
      bg: 'rgba(10, 10, 10, 0.95)',
      borderRadius: '24px',
      p: 6,
      border: '1px solid',
      borderColor: 'rgba(255, 255, 255, 0.3)',
      boxShadow: '0 4px 24px rgba(0, 0, 0, 0.4)',
    },
    subtle: {
      bg: 'rgba(10, 10, 10, 0.6)',
      borderRadius: '24px',
      p: 6,
      border: '1px solid',
      borderColor: 'rgba(255, 255, 255, 0.1)',
    },
  }

  // Add interactive styles if card is clickable
  const interactiveStyles = interactive
    ? {
        cursor: 'pointer',
        transition: TRANSITIONS.transformAndShadow,
        _hover: HOVER_EFFECTS.scale,
        _active: {
          transform: 'scale(0.98)',
        },
      }
    : {}

  return (
    <Box {...variants[variant]} {...interactiveStyles} {...props}>
      {children}
    </Box>
  )
}

export default Card
