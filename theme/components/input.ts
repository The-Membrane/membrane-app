import { colors } from '@/config/defaults'
import type { ComponentStyleConfig } from '@chakra-ui/react'

/**
 * Standardized Input Field Styling
 *
 * Ensures consistent input appearance across all forms and modals.
 */
export const Input: ComponentStyleConfig = {
  baseStyle: {
    field: {
      borderRadius: '16px',
      border: '1px solid',
      boxShadow: '0px 6px 24px 0px rgba(26, 26, 26, 0.04)',
      px: 6,
      py: 2,
      fontSize: 'lg',
      w: 'full',
      textAlign: 'right',
      transition: 'all 0.2s',
    },
  },
  variants: {
    /**
     * Standard outline variant (default)
     */
    outline: {
      field: {
        border: '1px solid',
        borderColor: colors.inputBorder,
        color: colors.link,
        background: colors.inputBG,
        _focusVisible: {
          borderColor: colors.link,
          boxShadow: `0 0 0 1px ${colors.link}`,
          outline: 'none',
        },
        _hover: {
          borderColor: colors.link,
        },
        _invalid: {
          borderColor: 'red.400',
          _focusVisible: {
            borderColor: 'red.400',
            boxShadow: '0 0 0 1px #ef4444',
          },
        },
        _disabled: {
          opacity: 0.6,
          cursor: 'not-allowed',
          borderColor: 'gray.600',
        },
      },
    },
    /**
     * Filled variant for inline editing
     */
    filled: {
      field: {
        border: 'none',
        background: 'rgba(255, 255, 255, 0.05)',
        color: 'white',
        _hover: {
          background: 'rgba(255, 255, 255, 0.08)',
        },
        _focusVisible: {
          background: 'rgba(255, 255, 255, 0.1)',
          borderColor: colors.link,
        },
      },
    },
    /**
     * Unstyled variant for custom styling
     */
    unstyled: {
      field: {
        background: 'transparent',
        border: 'none',
        boxShadow: 'none',
        px: 0,
        py: 0,
        fontSize: 'inherit',
      },
    },
  },
  defaultProps: {
    variant: 'outline',
    size: 'md',
  },
}
