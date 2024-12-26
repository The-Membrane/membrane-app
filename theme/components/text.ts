import type { ComponentStyleConfig } from '@chakra-ui/react'
import { colors } from '@/config/defaults'

export const Text: ComponentStyleConfig = {
  variants: {
    title: {
      fontSize: 'xl',
      fontWeight: 'bold',
      color: colors.sliderTrack,
      // textShadow: '0px 0px 8px rgba(223, 140, 252, 0.80)',
      letterSpacing: '8px',
      textTransform: 'uppercase',
    },
    lable: {
      color: colors.sliderTrack,
      // textShadow: '0px 0px 8px rgba(223, 140, 252, 0.80)',
      fontSize: 'md',
      fontWeight: 'bold',
      letterSpacing: '1.28px',
      textTransform: 'uppercase',
    },
    value: {
      color: colors.sliderTrack,
      // textShadow: '0px 0px 8px rgba(223, 140, 252, 0.80)',
      fontSize: 'xs',
      fontWeight: 'bold',
      letterSpacing: '0.96px',
      textTransform: 'uppercase',
    },
    light: {
      color: colors.textLight,
    },
  },
}
