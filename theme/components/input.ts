import { colors } from '@/config/defaults'
import type { ComponentStyleConfig } from '@chakra-ui/react'

export const Input: ComponentStyleConfig = {
  baseStyle: {
    field: {
      borderRadius: '16px',
      border: '1px solid',
      boxShadow: '0px 6px 24px 0px rgba(26, 26, 26, 0.04)',
      px: 6,
      py: 2,
      // h: 12,
      fontSize: 'lg',
      w: 'full',
      textAlign: 'right',
    },
  },
  variants: {
    outline: {
      field: {
        border: '1px solid',
        borderColor: colors.inputBorder,
        color: colors.link,
        background: colors.inputBG,
        _focusVisible: {
          borderColor: colors.link,
        },
        _hover: {
          borderColor: colors.link,
        },
      },
    },
  },
}
