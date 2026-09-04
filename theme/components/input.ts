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
        color: 'var(--m-text-primary)',
        background: colors.inputBG, // raised #100f12
        // Focus = 1px phosphor border (no blurred ring).
        _focusVisible: {
          borderColor: 'var(--m-primary)',
          boxShadow: '0 0 0 1px var(--m-primary)',
          outline: 'none',
        },
        _hover: {
          borderColor: 'var(--m-border-strong)',
        },
        _invalid: {
          borderColor: 'var(--m-danger)',
          _focusVisible: {
            borderColor: 'var(--m-danger)',
            boxShadow: '0 0 0 1px var(--m-danger)',
          },
        },
        _disabled: {
          opacity: 0.6,
          cursor: 'not-allowed',
          borderColor: 'var(--m-border-subtle)',
        },
      },
    },
    /**
     * Filled variant for inline editing
     */
    filled: {
      field: {
        border: 'none',
        background: 'var(--m-bg-tertiary)',
        color: 'var(--m-text-primary)',
        _hover: {
          background: 'var(--m-bg-secondary)',
        },
        _focusVisible: {
          background: 'var(--m-bg-tertiary)',
          borderColor: 'var(--m-primary)',
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
