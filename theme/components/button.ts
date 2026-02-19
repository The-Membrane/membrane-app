import { colors } from '@/config/defaults'
import { type ComponentStyleConfig } from '@chakra-ui/react'
import { TRANSITIONS, HOVER_EFFECTS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions'

export const Button: ComponentStyleConfig = {
  baseStyle: {
    borderRadius: '8px',
    fontWeight: 'bold',
    py: 2,
    px: 3,
    w: 'full',
    cursor: 'pointer',
    // Add smooth transitions to all buttons
    transition: TRANSITIONS.transformAndShadow,
    // Accessible focus indicator
    _focus: FOCUS_STYLES.ring,
    _focusVisible: FOCUS_STYLES.ring,
  },
  defaultProps: {
    colorScheme: 'purple',
    variant: 'solid',
  },
  variants: {
    solid: {
      color: 'white',
      bg: 'purple.500',
      borderColor: colors.link,
      border: 'none',
      fontSize: 'md',
      // Enhanced hover with lift effect
      _hover: {
        bg: 'purple.400',
        ...HOVER_EFFECTS.lift,
        _disabled: {
          bg: 'purple.500',
          transform: 'none',
          boxShadow: 'none',
        },
      },
      // Pressed state
      _active: {
        bg: 'purple.600',
        ...ACTIVE_EFFECTS.press,
      },
      // Disabled state
      _disabled: {
        opacity: 0.6,
        cursor: 'not-allowed',
      },
    },
    link: {
      bg: 'transparent',
      w: 'auto',
      color: colors.link,
      border: 'none',
      boxShadow: 'none',
      transition: TRANSITIONS.color,
      _hover: {
        textDecoration: 'underline',
        bg: 'transparent',
        color: colors.linkHover,
        ...HOVER_EFFECTS.brighten,
        _disabled: {
          color: colors.link,
          filter: 'none',
        },
      },
      _active: {
        color: colors.link,
      },
    },
    ghost: {
      fontWeight: '500',
      bg: 'transparent',
      border: '1px solid',
      borderColor: 'whiteAlpha.200',
      transition: TRANSITIONS.all,
      // Border highlight on hover
      _hover: {
        ...HOVER_EFFECTS.borderHighlight,
        bg: 'whiteAlpha.50',
        _disabled: {
          bg: 'transparent',
          borderColor: 'whiteAlpha.200',
        },
      },
      // Subtle press effect
      _active: {
        bg: 'whiteAlpha.100',
        ...ACTIVE_EFFECTS.pressDown,
      },
      _disabled: {
        opacity: 0.4,
        cursor: 'not-allowed',
      },
    },
    outline: {
      bg: 'transparent',
      border: '1px solid',
      borderColor: 'purple.400',
      color: 'purple.300',
      transition: TRANSITIONS.all,
      _hover: {
        bg: 'purple.900',
        borderColor: 'purple.300',
        ...HOVER_EFFECTS.liftSubtle,
        _disabled: {
          bg: 'transparent',
          borderColor: 'purple.400',
          transform: 'none',
        },
      },
      _active: {
        bg: 'purple.800',
        ...ACTIVE_EFFECTS.press,
      },
      _disabled: {
        opacity: 0.4,
        cursor: 'not-allowed',
      },
    },
  },
}
