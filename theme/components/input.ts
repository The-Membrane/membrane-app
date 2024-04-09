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
        borderColor: '#824784',
        color: 'primary.200',
        background: '#0C0410',
        _focusVisible: {
          borderColor: 'primary.200',
        },
        _hover: {
          borderColor: 'primary.200',
        },
      },
    },
  },
}
