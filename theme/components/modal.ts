import { colors } from '@/config/defaults'
import type { ComponentStyleConfig } from '@chakra-ui/react'

// Living Typeface modal: card surface + 1px bone hairline, SHARP corners, no glow.
export const Modal: ComponentStyleConfig = {
  baseStyle: {
    dialog: {
      borderRadius: '0', // sharp
      bg: colors.modalBG, // card surface #0e0d10
      border: '1px solid',
      borderColor: 'var(--m-border-strong)',
      boxShadow: 'none',
      padding: '6',
    },
    overlay: {
      bg: 'rgba(9, 9, 10, 0.72)', // near-black scrim
      backdropFilter: 'blur(10px)',
    },
  },
}
