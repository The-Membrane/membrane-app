import React from 'react'
import { Box, BoxProps } from '@chakra-ui/react'
import { TRANSITIONS, HOVER_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'

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
// Living Typeface: sharp corners, bone hairline borders, near-black card surface.
// No rounded corners, no glass blur, no drop shadow.
const variants = {
  default: {
    bg: SEMANTIC_COLORS.bgSecondary,
    borderRadius: 0,
    p: 6,
    border: '1px solid',
    borderColor: SEMANTIC_COLORS.borderMedium,
  },
  elevated: {
    bg: SEMANTIC_COLORS.bgSecondary,
    borderRadius: 0,
    p: 6,
    border: '1px solid',
    borderColor: SEMANTIC_COLORS.borderStrong,
  },
  subtle: {
    bg: SEMANTIC_COLORS.bgSecondary,
    borderRadius: 0,
    p: 6,
    border: '1px solid',
    borderColor: SEMANTIC_COLORS.borderSubtle,
  },
}

export const Card: React.FC<CardProps> = ({
  children,
  variant = 'default',
  interactive = false,
  ...props
}) => {
  const { onClick, onKeyDown } = props

  // Keyboard activation for interactive cards. A clickable Card is a real
  // control, so it must be reachable and operable from the keyboard — Enter
  // and Space fire the same onClick a mouse would.
  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      onKeyDown?.(event)
      if (event.defaultPrevented) return
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      onClick?.(event as unknown as React.MouseEvent<HTMLDivElement>)
    },
    [onClick, onKeyDown]
  )

  // Add interactive styles if card is clickable — Living Typeface: hairline
  // brightens on hover, slight dim on press, crisp phosphor outline on focus.
  // No scale, no lift, no glow.
  const interactiveStyles = interactive
    ? {
        cursor: 'pointer',
        transition: TRANSITIONS.colors,
        _hover: HOVER_EFFECTS.borderHighlight,
        _active: {
          opacity: 0.9,
        },
        _focus: FOCUS_STYLES.ring,
        _focusVisible: FOCUS_STYLES.ring,
      }
    : {}

  // Only a Card that actually handles a click gets button semantics.
  const keyboardProps =
    interactive && onClick
      ? {
          role: 'button' as const,
          tabIndex: 0,
        }
      : {}

  return (
    <Box
      {...variants[variant]}
      {...interactiveStyles}
      {...keyboardProps}
      {...props}
      onKeyDown={interactive && onClick ? handleKeyDown : onKeyDown}
    >
      {children}
    </Box>
  )
}

export default Card
