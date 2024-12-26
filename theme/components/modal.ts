import { colors } from '@/config/defaults'
import type { ComponentStyleConfig } from '@chakra-ui/react'

export const Modal: ComponentStyleConfig = {
  baseStyle: {
    dialog: {
      // bg: '#05071B',
      borderRadius: '24px',
      // border: '2px solid rgba(250, 129, 253, 0.37)',
      // background: 'rgba(5, 7, 27, 0.75)',
      bg: colors.modalBG,
      // boxShadow: '0px 0px 24px 0px rgba(250, 129, 253, 0.32)',
      backdropFilter: 'blur(6px)',
      padding: '6',
    },
    overlay: {
      backdropFilter: 'blur(10px)',
    },
  },
}
