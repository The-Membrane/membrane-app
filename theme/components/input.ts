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
      borderRadius: '0', // sharp
      border: '1px solid',
      boxShadow: 'none',
      px: 6,
      py: 2,
      // Numbers/data are mono in Living Typeface; inputs are data entry.
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 'lg',
      w: 'full',
      textAlign: 'right',
      transition: 'border-color 0.15s ease, color 0.15s ease',
    },
  },
  variants: {
    /**
     * Standard outline variant (default)
     */
    outline: {
      field: {
        border: '1px solid',
        borderColor: colors.inputBorder, // bone hairline
        color: '#ece6d8',
        background: colors.inputBG, // raised #100f12
        // Focus = 1px phosphor border (no blurred ring).
        _focusVisible: {
          borderColor: '#9bdc4f',
          boxShadow: '0 0 0 1px #9bdc4f',
          outline: 'none',
        },
        _hover: {
          borderColor: 'rgba(236, 230, 216, 0.22)',
        },
        _invalid: {
          borderColor: '#cf4034',
          _focusVisible: {
            borderColor: '#cf4034',
            boxShadow: '0 0 0 1px #cf4034',
          },
        },
        _disabled: {
          opacity: 0.6,
          cursor: 'not-allowed',
          borderColor: 'rgba(236, 230, 216, 0.10)',
        },
      },
    },
    /**
     * Filled variant for inline editing
     */
    filled: {
      field: {
        border: 'none',
        background: '#100f12',
        color: '#ece6d8',
        _hover: {
          background: '#0e0d10',
        },
        _focusVisible: {
          background: '#100f12',
          borderColor: '#9bdc4f',
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
