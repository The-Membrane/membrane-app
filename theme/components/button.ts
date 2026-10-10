import { colors } from '@/config/defaults'
import { type ComponentStyleConfig } from '@chakra-ui/react'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'

// Living Typeface buttons: transparent bg, 1px bone hairline, mono uppercase
// letter-spaced label, SHARP corners. Hover lifts with a shadow; only the
// momentary pressed state changes the border to phosphor. Pointer focus must
// not masquerade as selection; keyboard focus keeps its accessible ring.
const HAIRLINE = 'var(--m-border-subtle)'
const HAIRLINE_STRONG = 'var(--m-border-strong)'
const INK = 'var(--m-text-primary)'
const INK_DIM = 'var(--m-text-secondary)'
const PHOS = 'var(--m-primary)'
const RAISED = 'var(--m-bg-tertiary)'

export const Button: ComponentStyleConfig = {
  baseStyle: {
    borderRadius: '0', // sharp
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontWeight: '500',
    fontSize: '11px',
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    py: 2,
    px: 3,
    w: 'full',
    cursor: 'pointer',
    transition: `${TRANSITIONS.colors}, box-shadow 0.15s ease`,
    _focus: { outline: 'none' },
    _focusVisible: FOCUS_STYLES.ring,
    '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
  },
  defaultProps: {
    colorScheme: 'primary',
    variant: 'solid',
  },
  variants: {
    // "solid" is the primary CTA. In Living Typeface it reads as a phosphor-outlined
    // affordance rather than a filled purple block.
    solid: {
      color: INK,
      bg: 'transparent',
      border: '1px solid',
      borderColor: HAIRLINE_STRONG,
      _hover: {
        color: PHOS,
        borderColor: HAIRLINE_STRONG,
        bg: RAISED,
        boxShadow: 'md',
        _disabled: {
          bg: 'transparent',
          borderColor: HAIRLINE_STRONG,
          color: INK,
        },
      },
      _active: {
        color: PHOS,
        borderColor: PHOS,
        bg: RAISED,
        boxShadow: 'sm',
      },
      _disabled: {
        opacity: 0.4,
        cursor: 'not-allowed',
      },
    },
    link: {
      bg: 'transparent',
      w: 'auto',
      color: colors.link,
      border: 'none',
      boxShadow: 'none',
      textTransform: 'none',
      letterSpacing: 'normal',
      transition: TRANSITIONS.color,
      _hover: {
        textDecoration: 'underline',
        bg: 'transparent',
        color: colors.linkHover,
        _disabled: {
          color: colors.link,
        },
      },
      _active: {
        color: colors.link,
      },
    },
    ghost: {
      bg: 'transparent',
      border: '1px solid',
      borderColor: HAIRLINE,
      color: INK_DIM,
      transition: `${TRANSITIONS.colors}, box-shadow 0.15s ease`,
      _hover: {
        color: INK,
        borderColor: HAIRLINE_STRONG,
        bg: 'transparent',
        boxShadow: 'md',
        _disabled: {
          bg: 'transparent',
          borderColor: HAIRLINE,
          color: INK_DIM,
        },
      },
      _active: {
        color: PHOS,
        borderColor: PHOS,
        bg: RAISED,
        boxShadow: 'sm',
      },
      _disabled: {
        opacity: 0.4,
        cursor: 'not-allowed',
      },
    },
    outline: {
      bg: 'transparent',
      border: '1px solid',
      borderColor: HAIRLINE_STRONG,
      color: INK,
      transition: `${TRANSITIONS.colors}, box-shadow 0.15s ease`,
      _hover: {
        color: PHOS,
        borderColor: HAIRLINE_STRONG,
        bg: RAISED,
        boxShadow: 'md',
        _disabled: {
          bg: 'transparent',
          borderColor: HAIRLINE_STRONG,
          color: INK,
        },
      },
      _active: {
        color: PHOS,
        borderColor: PHOS,
        bg: RAISED,
        boxShadow: 'sm',
      },
      _disabled: {
        opacity: 0.4,
        cursor: 'not-allowed',
      },
    },
  },
}
