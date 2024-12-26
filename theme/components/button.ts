import { colors } from '@/config/defaults'
import { type ComponentStyleConfig } from '@chakra-ui/react'

export const Button: ComponentStyleConfig = {
  baseStyle: {
    borderRadius: '8px',
    fontWeight: 'bold',
    py: 2,
    px: 3,
    w: 'full',
    cursor: 'pointer',
  },
  variants: {
    solid: {
      color: 'white',
      borderColor: colors.link,
      border: 'none',
      // boxShadow: '0px 0px 16px 0px rgba(0, 163, 249, 0.32)',
      fontSize: 'md',
    },
    link: {
      bg: 'transparent',
      w: 'auto',
      color: colors.link,
      border: 'none',
      boxShadow: 'none',
      _hover: {
        textDecoration: 'underline',
        bg: 'transparent',
        color: colors.linkHover,
      },
    },
    ghost: {
      fontWeight: '500',
    },
  },
}
